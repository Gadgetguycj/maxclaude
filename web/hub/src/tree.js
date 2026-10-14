import crypto from 'node:crypto';
import { getDb } from './db.js';

export const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class TreeError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

export function cleanFolderName(value) {
  if (typeof value !== 'string') throw new TreeError(400, 'bad_name', 'name is required');
  const name = value.trim();
  if (!name.length || name.length > 64) throw new TreeError(400, 'bad_name', 'name must be 1 to 64 characters');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new TreeError(400, 'bad_name', 'name contains control characters');
  return name;
}

export function cleanSessionName(value) {
  if (typeof value !== 'string' || !SESSION_NAME_RE.test(value)) {
    throw new TreeError(400, 'bad_session_name', 'session name must match [A-Za-z0-9._-] and be 1 to 64 characters');
  }
  return value;
}

export function cleanPanes(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new TreeError(400, 'bad_panes', 'pane count must be 1 to 4');
  return n;
}

export function cleanWorkdir(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new TreeError(400, 'bad_workdir', 'working directory must be a string');
  const dir = value.trim();
  if (!dir.startsWith('/')) throw new TreeError(400, 'bad_workdir', 'working directory must be an absolute path');
  if (dir.length > 512 || /[\u0000-\u001f\u007f]/.test(dir)) {
    throw new TreeError(400, 'bad_workdir', 'working directory is not a valid path');
  }
  return dir;
}

export function cleanResumeSid(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TreeError(400, 'bad_resume_sid', 'resume id must be a uuid');
  }
  return value;
}

export function getNode(id) {
  return getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(id) || null;
}

export function listNodes() {
  return getDb().prepare('SELECT * FROM nodes ORDER BY position ASC, name ASC').all();
}

export function findSessionLeaf(sessionName) {
  return getDb().prepare('SELECT * FROM nodes WHERE session_name = ?').get(sessionName) || null;
}

export function renameSessionLeaf(id, newName) {
  const node = getNode(id);
  if (!node) throw new TreeError(404, 'not_found', 'leaf does not exist');
  if (node.kind !== 'session') throw new TreeError(400, 'not_a_session', 'that node is not a session');
  const clean = cleanSessionName(newName);
  getDb().prepare('UPDATE nodes SET name = ?, session_name = ? WHERE id = ?').run(clean, clean, id);
  return getNode(id);
}

function assertParent(parentId) {
  if (parentId === undefined || parentId === null || parentId === '') return null;
  const parent = getNode(parentId);
  if (!parent) throw new TreeError(404, 'parent_not_found', 'parent folder does not exist');
  if (parent.kind !== 'folder') throw new TreeError(400, 'parent_not_folder', 'parent must be a folder');
  return parent.id;
}

function nextPosition(parentId) {
  const row = getDb()
    .prepare('SELECT MAX(position) AS m FROM nodes WHERE parent_id IS ?')
    .get(parentId);
  return (row && row.m !== null ? row.m : 0) + 1000;
}

export function createFolder(name, parentId) {
  const clean = cleanFolderName(name);
  const parent = assertParent(parentId);
  const node = {
    id: newId(),
    parent_id: parent,
    kind: 'folder',
    name: clean,
    position: nextPosition(parent),
    session_name: null,
    panes: null,
    workdir: null,
    resume_sid: null,
    created_at: Date.now()
  };
  insert(node);
  return node;
}

export function createSessionLeaf({ sessionName, panes, workdir, resumeSid, parentId }) {
  const parent = assertParent(parentId);
  if (findSessionLeaf(sessionName)) {
    throw new TreeError(409, 'session_exists', `a leaf for session ${sessionName} already exists`);
  }
  const node = {
    id: newId(),
    parent_id: parent,
    kind: 'session',
    name: sessionName,
    position: nextPosition(parent),
    session_name: sessionName,
    panes,
    workdir,
    resume_sid: resumeSid,
    created_at: Date.now()
  };
  insert(node);
  return node;
}

function insert(node) {
  getDb()
    .prepare(
      `INSERT INTO nodes (id, parent_id, kind, name, position, session_name, panes, workdir, resume_sid, created_at)
       VALUES (@id, @parent_id, @kind, @name, @position, @session_name, @panes, @workdir, @resume_sid, @created_at)`
    )
    .run(node);
}

export function isDescendant(candidateId, ancestorId) {
  let cursor = getNode(candidateId);
  const seen = new Set();
  while (cursor && cursor.parent_id) {
    if (seen.has(cursor.parent_id)) return false;
    seen.add(cursor.parent_id);
    if (cursor.parent_id === ancestorId) return true;
    cursor = getNode(cursor.parent_id);
  }
  return false;
}

export function updateNode(id, patch) {
  const node = getNode(id);
  if (!node) throw new TreeError(404, 'not_found', 'node does not exist');

  const fields = {};

  if (patch.name !== undefined) {
    if (node.kind !== 'folder') {
      throw new TreeError(400, 'rename_not_supported', 'only folders can be renamed');
    }
    fields.name = cleanFolderName(patch.name);
  }

  if (patch.parent_id !== undefined) {
    const parent = assertParent(patch.parent_id);
    if (parent === id) throw new TreeError(400, 'cycle', 'a folder cannot contain itself');
    if (parent && node.kind === 'folder' && isDescendant(parent, id)) {
      throw new TreeError(400, 'cycle', 'a folder cannot be moved into its own descendant');
    }
    fields.parent_id = parent;
  }

  if (patch.position !== undefined) {
    const pos = Number(patch.position);
    if (!Number.isFinite(pos)) throw new TreeError(400, 'bad_position', 'position must be a number');
    fields.position = pos;
  } else if (fields.parent_id !== undefined && fields.parent_id !== node.parent_id) {
    fields.position = nextPosition(fields.parent_id);
  }

  const keys = Object.keys(fields);
  if (!keys.length) return node;

  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  getDb().prepare(`UPDATE nodes SET ${assignments} WHERE id = @id`).run({ ...fields, id });
  return getNode(id);
}

export function subtree(id) {
  const all = listNodes();
  const byParent = new Map();
  for (const node of all) {
    const key = node.parent_id || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }
  const out = [];
  const stack = [id];
  while (stack.length) {
    const current = stack.pop();
    for (const child of byParent.get(current) || []) {
      out.push(child);
      stack.push(child.id);
    }
  }
  return out;
}

export function deleteNodeRow(id) {
  getDb().prepare('DELETE FROM nodes WHERE id = ?').run(id);
}

export function reparentChildren(id, newParentId) {
  const base = nextPosition(newParentId);
  const children = getDb().prepare('SELECT id FROM nodes WHERE parent_id IS ? ORDER BY position ASC').all(id);
  const update = getDb().prepare('UPDATE nodes SET parent_id = ?, position = ? WHERE id = ?');
  children.forEach((child, index) => update.run(newParentId, base + index * 1000, child.id));
}
