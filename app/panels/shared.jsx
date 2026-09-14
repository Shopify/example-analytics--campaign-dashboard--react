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

// Each chip names what one capability does in this panel. `s-chip` takes no
// `interestFor`, leaving the clickable variant as the tooltip's trigger.
// `s-section`'s `heading` takes no elements. Each panel renders its heading in the body.
export function PanelHeader({title, uses}) {
  const slug = title.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase();
  return (
    <s-stack
      direction="inline"
      gap="base"
      alignItems="center"
      style={{marginBottom: '12px'}}
    >
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
  );
}
