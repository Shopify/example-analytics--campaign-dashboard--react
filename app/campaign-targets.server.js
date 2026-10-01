import {progressQuery, progressValue, targetNodes as readNodes} from './campaign-queries.server';

// [START campaign-dashboard.measure-targets]
// Results read back by position. `measurable.indexOf` maps each result to its target.
export async function measureTargets(admin, campaign, targetsBody) {
  const recorded = new Set(Object.values(campaign.targets ?? {}));
  const targetNodes = readNodes(targetsBody).filter(
    (target) => recorded.has(target.id),
  );
  const measurable = targetNodes.filter((target) => target.shopifyqlQuery);
  const body = measurable.length
    ? await (await admin.graphql(progressQuery(measurable))).json()
    : {};
  const progress = body.data ?? {};
  // A throttled or failed read shows on every card. Silence reads as no progress.
  const unread = body.errors?.[0]?.message ?? null;

  return targetNodes.map((target) => {
    const index = measurable.indexOf(target);
    const actual = index === -1 ? null : progressValue(progress[`t${index}`]);
    const expected = Number(target.expectedValue);
    return {
      ...target,
      actual,
      percent:
        actual === null || expected <= 0
          ? null
          : Math.round((actual / expected) * 100),
      queryError:
        index === -1
          ? `Couldn't measure ${target.metric}. Reload to try again.`
          : (progress[`t${index}`]?.parseErrors?.[0] ??
            (actual === null ? unread : null)),
    };
  });
}
// [END campaign-dashboard.measure-targets]
