import {Fragment} from 'react';

// What produced the number changes what it means. Every panel names its capabilities.
export const CAPABILITIES = {
  shopifyql: {icon: 'database', label: 'ShopifyQL'},
  appEvents: {icon: 'apps', label: 'App Events'},
  metafields: {icon: 'metafields', label: 'Metafields'},
  annotations: {icon: 'note', label: 'Annotations'},
  targets: {icon: 'target', label: 'Targets'},
  components: {icon: 'code', label: 'Web components'},
};

// Rounded to a whole number, a small share reads as 0% and looks like nothing sold.
export const sharePercent = (share) =>
  share > 0 && share < 1 ? 'less than 1%' : `${Math.round(share)}%`;

// `s-chip` takes no `interestFor`. The clickable variant triggers the tooltip. `s-section`'s
// `heading` takes no elements, and each panel renders its heading in the body.
export function PanelHeader({title, uses}) {
  const slug = title.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase();
  return (
    <Fragment>
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-heading>{title}</s-heading>
        {Object.entries(uses).map(([key, note]) => {
          const id = `uses-${slug}-${key}`;
          return (
            <Fragment key={key}>
              <s-tooltip id={id}>{note}</s-tooltip>
              <s-clickable-chip
                color="subdued"
                interestFor={id}
                accessibilityLabel={`Built on ${CAPABILITIES[key].label}`}
              >
                <s-icon slot="graphic" type={CAPABILITIES[key].icon} size="small" />
                {CAPABILITIES[key].label}
              </s-clickable-chip>
            </Fragment>
          );
        })}
      </s-stack>
      {/* The stack drops a style prop. The box holds the gap under the header. */}
      <s-box paddingBlockStart="base" />
    </Fragment>
  );
}
