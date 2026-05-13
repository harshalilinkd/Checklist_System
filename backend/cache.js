const { LRUCache } = require('lru-cache');

const masterCache = new LRUCache({ max: 500, ttl: 60 * 1000 });          // 60s
const refCache    = new LRUCache({ max: 50,  ttl: 6 * 60 * 60 * 1000 }); // 6h

function masterKey(userEmail) {
  const today = new Date().toISOString().slice(0, 10);
  return `master:${userEmail || 'all'}:${today}`;
}

function invalidateMaster() { masterCache.clear(); }
function invalidateDoers()  { refCache.delete('doers'); }
function invalidateTasks()  { refCache.delete('tasks'); }
function invalidateAll()    { masterCache.clear(); refCache.clear(); }

module.exports = {
  masterCache, refCache, masterKey,
  invalidateMaster, invalidateDoers, invalidateTasks, invalidateAll,
};
