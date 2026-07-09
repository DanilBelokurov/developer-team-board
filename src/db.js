import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const defaultData = { tickets: {} };

let db = null;

export async function initDb(file) {
  db = new Low(new JSONFile(file), defaultData);
  await db.read();
  db.data ||= structuredClone(defaultData);
  await db.write();
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialized — call initDb() first');
  return db;
}

export function getTicket(id) {
  return getDb().data.tickets[id] || null;
}

export function upsertTicket(ticket) {
  getDb().data.tickets[ticket.id] = ticket;
  return getDb().write();
}

export function patchTicket(id, patch) {
  const t = getTicket(id);
  if (!t) return null;
  Object.assign(t, patch);
  return getDb().write().then(() => t);
}

export function deleteTicket(id) {
  delete getDb().data.tickets[id];
  return getDb().write();
}

export function listTickets() {
  return Object.values(getDb().data.tickets);
}
