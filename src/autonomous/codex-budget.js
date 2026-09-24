const CODEX_BUDGET = Object.freeze({ buildCalls: 3, repairCalls: 2 });

function codexUsage(run) {
  return {
    buildCalls: Number.isInteger(run.codexUsage?.buildCalls) && run.codexUsage.buildCalls >= 0 ? run.codexUsage.buildCalls : 0,
    repairCalls: Number.isInteger(run.codexUsage?.repairCalls) && run.codexUsage.repairCalls >= 0 ? run.codexUsage.repairCalls : 0
  };
}

module.exports = { CODEX_BUDGET, codexUsage };
