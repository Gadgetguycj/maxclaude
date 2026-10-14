const counts = new Map();
const leases = new Map();
let sequence = 0;

export function addViewer(session) {
  if (!session) return;
  counts.set(session, (counts.get(session) || 0) + 1);
}

export function removeViewer(session) {
  if (!session) return;
  const next = (counts.get(session) || 1) - 1;
  if (next > 0) counts.set(session, next);
  else counts.delete(session);
}

export function viewerCount(session) {
  return counts.get(session) || 0;
}

export function clearViewers() {
  counts.clear();
  for (const lease of leases.values()) clearTimeout(lease.timer);
  leases.clear();
}

export function reserveViewer(session, ttlMs = 30000) {
  const id = `lease-${++sequence}`;
  addViewer(session);
  const timer = setTimeout(() => releaseViewerLease(id), ttlMs);
  timer.unref?.();
  leases.set(id, { session, timer });
  return id;
}

export function releaseViewerLease(id) {
  const lease = leases.get(id);
  if (!lease) return false;
  leases.delete(id);
  clearTimeout(lease.timer);
  removeViewer(lease.session);
  return true;
}

export function convertViewerLease(session) {
  for (const [id, lease] of leases) {
    if (lease.session !== session) continue;
    releaseViewerLease(id);
    addViewer(session);
    return true;
  }
  addViewer(session);
  return false;
}
