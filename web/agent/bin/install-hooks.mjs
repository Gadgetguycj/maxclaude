#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const commandPath = process.argv[2];
if (!commandPath || !path.isAbsolute(commandPath)) throw new Error('pass the absolute path to mcw-session-status');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
let settings = {};
if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error(`${settingsPath} must contain a JSON object`);
if (settings.hooks !== undefined && (!settings.hooks || Array.isArray(settings.hooks) || typeof settings.hooks !== 'object')) throw new Error(`${settingsPath} hooks must be a JSON object`);
settings.hooks ||= {};
function add(event, args) {
  const command = [commandPath, ...args].join(' ');
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  if (!groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => hook?.type === 'command' && hook.command === command))) groups.push({ hooks: [{ type: 'command', command }] });
  settings.hooks[event] = groups;
}
add('UserPromptSubmit', ['busy']);
add('PreToolUse', ['busy']);
add('Stop', ['idle', 'stop']);
add('Notification', ['idle']);
fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
const temporary = `${settingsPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, settingsPath);
console.log(`updated ${settingsPath}`);
