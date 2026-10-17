const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ 数据库初始化 ============
const db = new Database(path.join(__dirname, 'queue.db'));
db.pragma('journal_mode = WAL'); // 更好的并发读写

db.exec(`
  CREATE TABLE IF NOT EXISTS queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    phone     TEXT NOT NULL,
    code      TEXT NOT NULL,
    barber    TEXT NOT NULL DEFAULT 'default',
    status    TEXT NOT NULL DEFAULT 'waiting',  -- waiting | serving | done
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, barber);
  CREATE INDEX IF NOT EXISTS idx_queue_phone ON queue(phone, status);
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// 号码序号持久化（保证重启后继续递增，不重复）
const getSerial = () => {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'serial'`).get();
  return row ? parseInt(row.value, 10) : 1;
};
const setSerial = (n) => {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('serial', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(n));
};

// 初始化序号
if (!db.prepare(`SELECT 1 FROM meta WHERE key = 'serial'`).get()) {
  setSerial(1);
}

// 当前叫号持久化：每个理发师一条记录
const getCurrentCalled = (barber) => {
  const row = db.prepare(
    `SELECT code FROM queue WHERE status = 'serving' AND barber = ? ORDER BY id DESC LIMIT 1`
  ).get(barber);
  return row ? row.code : null;
};

const formatCode = (n) => 'A' + n.toString().padStart(3, '0');

// 常量配置
const MAX_QUEUE = 500; // 队列上限（防刷）

// ============ 工具函数 ============
function getQueueByBarber(barber) {
  return db.prepare(
    `SELECT id, phone, code, status FROM queue
     WHERE status = 'waiting' AND barber = ? ORDER BY id ASC`
  ).all(barber);
}

function getServingByBarber(barber) {
  return db.prepare(
    `SELECT id, phone, code FROM queue
     WHERE status = 'serving' AND barber = ? ORDER BY id DESC LIMIT 1`
  ).get(barber) || null;
}

// ============ 顾客端 API ============

// 取号
app.post('/api/take', (req, res) => {
  const { phone, barber = 'default' } = req.body || {};
  if (!phone || !/^\d{6,11}$/.test(phone)) {
    return res.status(400).json({ error: '请输入6~11位数字手机号' });
  }

  // 防重复：同一手机号在 waiting 或 serving 状态中
  const dup = db.prepare(
    `SELECT code FROM queue WHERE phone = ? AND status IN ('waiting','serving') LIMIT 1`
  ).get(phone);
  if (dup) {
    return res.status(409).json({ error: `该手机号已在排队中（号码 ${dup.code}）` });
  }

  // 防刷：等待队列总数上限
  const { cnt } = db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE status = 'waiting'`).get();
  if (cnt >= MAX_QUEUE) {
    return res.status(429).json({ error: '当前排队人数已满，请稍后再试' });
  }

  // 生成号码（事务内，避免并发冲突）
  const tx = db.transaction(() => {
    let serial = getSerial();
    const code = formatCode(serial);
    setSerial(serial + 1);
    const stmt = db.prepare(
      `INSERT INTO queue (phone, code, barber, status, created_at) VALUES (?, ?, ?, 'waiting', ?)`
    );
    const info = stmt.run(phone, code, barber, Date.now());
    return { id: info.lastInsertRowid, code };
  });
  const { id, code } = tx();

  res.json({ success: true, id, code, phone, barber });
});

// 查询状态（支持按理发师过滤；不传 barber 则汇总）
app.get('/api/status', (req, res) => {
  const { barber } = req.query;

  if (barber) {
    const waiting = getQueueByBarber(barber);
    const serving = getServingByBarber(barber);
    return res.json({
      barber,
      waitingCount: waiting.length,
      currentCalled: serving ? serving.code : null,
      waitingCodes: waiting.map(i => i.code),
    });
  }

  // 全部理发师汇总
  const rows = db.prepare(
    `SELECT barber,
            SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN status = 'serving' THEN 1 ELSE 0 END) AS serving
     FROM queue GROUP BY barber`
  ).all();
  const totalWaiting = rows.reduce((s, r) => s + (r.waiting || 0), 0);
  const waitingCodes = db.prepare(
    `SELECT code FROM queue WHERE status = 'waiting' ORDER BY id ASC LIMIT 50`
  ).all().map(r => r.code);
  res.json({
    waitingCount: totalWaiting,
    waitingCodes,
    byBarber: rows,
  });
});

// 顾客取消排队（按手机号 + 可选 barber）
app.post('/api/cancel', (req, res) => {
  const { phone } = req.body || {};
  if (!phone || !/^\d{6,11}$/.test(phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }
  const row = db.prepare(
    `SELECT id, code FROM queue WHERE phone = ? AND status = 'waiting' LIMIT 1`
  ).get(phone);
  if (!row) {
    return res.status(404).json({ error: '没有找到该手机号的排队记录' });
  }
  db.prepare(`DELETE FROM queue WHERE id = ?`).run(row.id);
  res.json({ success: true, code: row.code });
});

// ============ 商家端 API ============

// 获取完整队列（按理发师分组）
app.get('/api/merchant/queue', (req, res) => {
  const rows = db.prepare(
    `SELECT id, phone, code, barber, status FROM queue
   WHERE status IN ('waiting','serving')
   ORDER BY barber ASC,
            CASE status WHEN 'serving' THEN 0 ELSE 1 END,
            id ASC`
  ).all();

  // 按理发师整理
  const byBarber = {};
  for (const row of rows) {
    if (!byBarber[row.barber]) {
      byBarber[row.barber] = { barber: row.barber, waiting: [], serving: null };
    }
    if (row.status === 'waiting') {
      byBarber[row.barber].waiting.push(row);
    } else if (row.status === 'serving' && !byBarber[row.barber].serving) {
      byBarber[row.barber].serving = row;
    }
  }

  const totalWaiting = rows.filter(r => r.status === 'waiting').length;
  res.json({
    totalWaiting,
    byBarber: Object.values(byBarber),
  });
});

// 叫号（指定理发师）
app.post('/api/merchant/call', (req, res) => {
  const { barber = 'default', force = false } = req.body || {};

  // 该理发师已有正在服务的号码？
  const serving = getServingByBarber(barber);
  if (serving && !force) {
    return res.status(409).json({
      error: `理发师 ${barber} 正在服务 ${serving.code}，请先完成或强制覆盖`,
      currentServing: serving,
      needForce: true,
    });
  }

  const waiting = getQueueByBarber(barber);
  if (waiting.length === 0) {
    return res.status(400).json({ error: `理发师 ${barber} 没有等待中的顾客` });
  }

  const next = waiting[0];

  const tx = db.transaction(() => {
    // 若强制覆盖，把旧的 serving 退回 waiting
    if (serving && force) {
      db.prepare(`UPDATE queue SET status = 'waiting' WHERE id = ?`).run(serving.id);
    }
    db.prepare(`UPDATE queue SET status = 'serving' WHERE id = ?`).run(next.id);
    return next;
  });
  const called = tx();

  res.json({ success: true, currentCalled: called.code, barber });
});

// 完成当前（指定理发师）
app.post('/api/merchant/complete', (req, res) => {
  const { barber = 'default' } = req.body || {};
  const serving = getServingByBarber(barber);
  if (!serving) {
    return res.status(400).json({ error: `理发师 ${barber} 当前没有正在服务的顾客` });
  }
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = ?`).run(serving.id);
  res.json({ success: true, completed: serving.code, barber });
});

// 商家手动移除某条排队记录（异常处理，如顾客走了）
app.delete('/api/merchant/queue/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID 无效' });
  const info = db.prepare(`DELETE FROM queue WHERE id = ? AND status IN ('waiting','serving')`).run(id);
  if (info.changes === 0) return res.status(404).json({ error: '记录不存在' });
  res.json({ success: true });
});

// 启动
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✂️ 理发店排队服务已启动: http://localhost:${PORT}`);
});