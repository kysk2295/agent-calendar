#!/usr/bin/env node
'use strict';

const {
  buildRouteLifecycleReport,
} = require('../app/lib/route-lifecycle');

const strictMobileEntry = process.argv.includes('--require-mobile-entry');
const asOfArgument = process.argv.find((argument) => argument.startsWith('--as-of='));
const asOf = asOfArgument
  ? asOfArgument.slice('--as-of='.length)
  : new Date().toISOString().slice(0, 10);
const report = buildRouteLifecycleReport({ asOf });
const bounded = {
  schemaVersion: report.schemaVersion,
  asOf: report.asOf,
  totalRoutes: report.totalRoutes,
  classifiedRoutes: report.classifiedRoutes,
  classificationComplete: report.classificationComplete,
  mobileEntryReady: report.mobileEntryReady,
  lifecycleCounts: report.lifecycleCounts,
  supportedClientDisabledRoutes: report.supportedClientDisabledRoutes,
  compatibilityRoutes: report.compatibilityRoutes,
  removalCandidates: report.removalCandidates,
  testOnlyRoutes: report.testOnlyRoutes,
  unclassifiedRoutes: report.unclassifiedRoutes,
  stalePolicyEntries: report.stalePolicyEntries,
  mobileEntryBlockers: report.mobileEntryBlockers,
};

process.stdout.write(`${JSON.stringify(bounded, null, 2)}\n`);
if (!report.classificationComplete) process.exitCode = 1;
else if (strictMobileEntry && !report.mobileEntryReady) process.exitCode = 2;
