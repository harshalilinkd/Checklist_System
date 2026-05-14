// GET /api/scorecard/:email?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns a monthly-style performance scorecard for one doer.
// Admin can view any doer; non-admin can view only themselves.
// Data is sourced from master_checklist + archive (UNIONed) so historical
// months (with archived Done rows) are included.

const express = require('express');
const { query } = require('../db');

const router = express.Router();

function toIso(d) { return d.toISOString().slice(0, 10); }

function computeKpis(rows) {
  const total = rows.length;
  const done = rows.filter(r => r.actual_date != null).length;
  const onTime = rows.filter(r => r.actual_date != null && r.actual_date <= r.planned_date).length;
  const delayed = rows.filter(r => r.status === 'Delayed' || (r.actual_date && r.actual_date > r.planned_date)).length;
  const onTimePct = done ? Math.round((onTime / done) * 100) : 0;
  const lateRows = rows.filter(r => r.actual_date && r.actual_date > r.planned_date);
  const avgDelayDays = lateRows.length
    ? +(lateRows.reduce((s, r) => s + ((new Date(r.actual_date) - new Date(r.planned_date)) / 86400000), 0) / lateRows.length).toFixed(1)
    : 0;
  return { total, done, delayed, onTime, onTimePct, avgDelayDays };
}

router.get('/:email', async (req, res, next) => {
  try {
    const email = req.params.email.toLowerCase();
    if (!req.user.isAdmin && req.user.email !== email) {
      return res.status(403).json({ error: 'Forbidden', code: 403 });
    }
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to query params required (YYYY-MM-DD)', code: 400 });
    }

    const fromD = new Date(from);
    const toD = new Date(to);
    const periodDays = Math.round((toD - fromD) / 86400000) + 1;

    // Previous period (same length, immediately before the selected period)
    const prevToD = new Date(fromD.getTime() - 86400000);
    const prevFromD = new Date(prevToD.getTime() - (periodDays - 1) * 86400000);
    const prevFrom = toIso(prevFromD);
    const prevTo = toIso(prevToD);

    // 6-month trend window — last 6 calendar months ending at the period's `to`
    const trendStart = new Date(toD.getFullYear(), toD.getMonth() - 5, 1);
    const sixMonthFrom = toIso(trendStart);
    const overallFrom = prevFrom < sixMonthFrom ? prevFrom : sixMonthFrom;

    // Doer info
    const doerR = await query('select id, name, email, department from doers where email = $1', [email]);
    if (doerR.rowCount === 0) return res.status(404).json({ error: 'Doer not found', code: 404 });
    const doer = doerR.rows[0];

    // Pull master + archive rows for the doer over the union of all windows we need
    const rowsR = await query(`
      with combined as (
        select planned_date, actual_date, status, task_id, freq
          from master_checklist
         where doer_email = $1 and planned_date between $2 and $3
        union all
        select planned_date, actual_date, status, task_id, freq
          from archive
         where doer_email = $1 and planned_date between $2 and $3
      )
      select c.*, t.task_name
        from combined c
        left join tasks t on t.task_id = c.task_id
    `, [email, overallFrom, to]);

    const allRows = rowsR.rows;

    const periodRows = allRows.filter(r => r.planned_date >= from && r.planned_date <= to);
    const prevRows   = allRows.filter(r => r.planned_date >= prevFrom && r.planned_date <= prevTo);

    const kpis = computeKpis(periodRows);
    const prevKpis = computeKpis(prevRows);

    // Streaks — among rows that have been completed, in date order
    const completed = [...periodRows].filter(r => r.actual_date).sort((a, b) => a.planned_date.localeCompare(b.planned_date));
    let bestStreak = 0, runningStreak = 0;
    for (const r of completed) {
      if (r.actual_date <= r.planned_date) {
        runningStreak++;
        if (runningStreak > bestStreak) bestStreak = runningStreak;
      } else {
        runningStreak = 0;
      }
    }
    kpis.bestStreak = bestStreak;
    kpis.currentStreak = runningStreak;

    // 6-month trend
    const trend6Months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(toD.getFullYear(), toD.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth();
      const monthStart = toIso(new Date(y, m, 1));
      const monthEnd = toIso(new Date(y, m + 1, 0));
      const mRows = allRows.filter(r => r.planned_date >= monthStart && r.planned_date <= monthEnd);
      const k = computeKpis(mRows);
      trend6Months.push({
        month: `${y}-${String(m + 1).padStart(2, '0')}`,
        label: d.toLocaleString('en-US', { month: 'short' }),
        onTimePct: k.onTimePct,
        done: k.done,
        total: k.total,
      });
    }

    // Daily breakdown for the selected period (filled with zeros for empty days).
    // Includes avgDelayDays and lastActualDate for heatmap cell details.
    const dailyMap = new Map();
    for (const r of periodRows) {
      if (!dailyMap.has(r.planned_date)) {
        dailyMap.set(r.planned_date, {
          date: r.planned_date, total: 0, done: 0, onTime: 0, delayed: 0,
          _delayDaysSum: 0, _lateCount: 0, lastActualDate: null,
        });
      }
      const d = dailyMap.get(r.planned_date);
      d.total++;
      if (r.actual_date) {
        d.done++;
        if (r.actual_date <= r.planned_date) d.onTime++;
        else {
          const days = Math.round((new Date(r.actual_date) - new Date(r.planned_date)) / 86400000);
          d._delayDaysSum += days;
          d._lateCount++;
        }
        if (!d.lastActualDate || r.actual_date > d.lastActualDate) d.lastActualDate = r.actual_date;
      }
      if (r.status === 'Delayed' || (r.actual_date && r.actual_date > r.planned_date)) d.delayed++;
    }
    const dailyBreakdown = [];
    for (let t = new Date(fromD); t <= toD; t.setDate(t.getDate() + 1)) {
      const iso = toIso(t);
      const d = dailyMap.get(iso);
      if (d) {
        d.avgDelayDays = d._lateCount ? +(d._delayDaysSum / d._lateCount).toFixed(1) : 0;
        delete d._delayDaysSum; delete d._lateCount;
        dailyBreakdown.push(d);
      } else {
        dailyBreakdown.push({ date: iso, total: 0, done: 0, onTime: 0, delayed: 0, avgDelayDays: 0, lastActualDate: null });
      }
    }

    // Frequency breakdown
    const freqMap = new Map();
    for (const r of periodRows) {
      const f = r.freq || '—';
      if (!freqMap.has(f)) freqMap.set(f, { freq: f, total: 0, done: 0, onTime: 0, late: 0 });
      const d = freqMap.get(f);
      d.total++;
      if (r.actual_date) {
        d.done++;
        if (r.actual_date <= r.planned_date) d.onTime++;
        else d.late++;
      }
    }
    const freqBreakdown = [...freqMap.values()].sort((a, b) => b.total - a.total);

    // Top tasks (most frequent in period)
    const taskMap = new Map();
    for (const r of periodRows) {
      if (!taskMap.has(r.task_id)) {
        taskMap.set(r.task_id, { task_id: r.task_id, task_name: r.task_name, count: 0, done: 0, onTime: 0 });
      }
      const d = taskMap.get(r.task_id);
      d.count++;
      if (r.actual_date) {
        d.done++;
        if (r.actual_date <= r.planned_date) d.onTime++;
      }
    }
    const topTasks = [...taskMap.values()]
      .map(t => ({ ...t, donePct: t.count ? Math.round((t.done / t.count) * 100) : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Strengths & weaknesses: tasks with enough samples, ranked by on-time %
    const taskRanked = [...taskMap.values()]
      .filter(t => t.count >= 3)
      .map(t => ({ ...t, onTimePct: t.count ? Math.round((t.onTime / t.count) * 100) : 0 }));
    const bestTasks  = [...taskRanked].sort((a, b) => b.onTimePct - a.onTimePct || b.count - a.count).slice(0, 3);
    const worstTasks = [...taskRanked].sort((a, b) => a.onTimePct - b.onTimePct || b.count - a.count).slice(0, 3);

    // Reliability score: composite 0–100. Weighted blend:
    //   50% on-time%  (quality of completion)
    //   30% volume completed-of-scheduled (throughput)
    //   20% streak-strength (consistency, capped at 30-day streak = 100)
    const completionPct = kpis.total ? (kpis.done / kpis.total) * 100 : 0;
    const streakScore = Math.min(100, (kpis.bestStreak / 30) * 100);
    const reliability = Math.round(0.5 * kpis.onTimePct + 0.3 * completionPct + 0.2 * streakScore);
    kpis.reliability   = reliability;
    kpis.completionPct = Math.round(completionPct);

    res.json({
      doer,
      period:        { from, to, label: `${from} → ${to}`, days: periodDays },
      kpis,
      previousMonth: { ...prevKpis, period: { from: prevFrom, to: prevTo } },
      trend6Months,
      dailyBreakdown,
      freqBreakdown,
      topTasks,
      bestTasks,
      worstTasks,
    });
  } catch (e) { next(e); }
});

module.exports = router;
