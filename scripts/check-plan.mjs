import { loadInputs, validatePlan, planMetrics, progressFor } from './lib.mjs';
const { plan, requirements } = loadInputs();
const errors = validatePlan(plan, requirements);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else {
  console.log(JSON.stringify({ result: 'PASS', tasks: plan.tasks.length, requirements: requirements.length,
    dependencyEdges: plan.tasks.reduce((n, t) => n + t.dependsOn.length, 0),
    initiallyReady: progressFor(plan).tasks.filter(t => t.displayStatus === 'ready').map(t => t.id),
    estimatesAreNotGuarantees: true, ...planMetrics(plan) }, null, 2));
}
