import {progressQuery, progressValue} from './campaign-queries.server';

// [START campaign-dashboard.measure-targets]
// Results read back by position. `measurable.indexOf` maps each result to its target.
export async function measureTargets(admin, campaign, targetsBody) {
  const recorded = new Set(Object.values(campaign.targets ?? {}));
  const targetNodes = (targetsBody.data?.analyticsTargets?.nodes ?? []).filter(
    (target) => recorded.has(target.id),
  );
  const measurable = targetNodes.filter((target) => target.shopifyqlQuery);
  const progress = measurable.length
    ? ((await (await admin.graphql(progressQuery(measurable))).json()).data ?? {})
    : {};

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
          ? `Shopify didn't return a query for ${target.metric} on this read. The target is valid, and the app can't measure progress without the query. Reload to try again.`
          : (progress[`t${index}`]?.parseErrors?.[0] ?? null),
    };
  });
}
// [END campaign-dashboard.measure-targets]
