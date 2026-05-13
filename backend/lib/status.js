// Computed status SQL fragment. Uses denormalized `freq` on master_checklist
// so no join is needed. Pass {today} as a parameter or use TODAY_SQL.

const { TODAY_SQL } = require('../db');

const COMPUTED_STATUS_SQL = `
  case
    when m.status = 'Done' then 'Done'
    when m.planned_date < ${TODAY_SQL} then 'Delayed'
    when m.planned_date = ${TODAY_SQL} then 'Today'
    when m.planned_date <= ${TODAY_SQL} + 7 and coalesce(m.freq, '') <> 'D' then 'Upcoming Focus'
    else 'Scheduled'
  end
`;

module.exports = { COMPUTED_STATUS_SQL };
