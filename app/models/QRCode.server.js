import qrcode from "qrcode";
import invariant from "tiny-invariant";

// [START get-qrcode]
const METAOBJECT_TYPE = "$app:qrcode";

export async function getQRCode(handle, graphql, shop) {
  const response = await graphql(
    `
      query GetQRCode($handle: MetaobjectHandleInput!) {
        metaobjectByHandle(handle: $handle) {
          id
          handle
          createdAt
          title: field(key: "title") { jsonValue }
          product: field(key: "product") {
            jsonValue
            reference {
              ... on Product {
                handle
                title
                media(first: 1) {
                  nodes {
                    preview {
                      image { url altText }
                    }
                  }
                }
              }
            }
          }
          productVariant: field(key: "product_variant") {
            reference {
              ... on ProductVariant { id legacyResourceId }
            }
          }
          destination: field(key: "destination") { jsonValue }
          scans: field(key: "scans") { jsonValue }
          liveOn: field(key: "live_on") { jsonValue }
        }
      }
    `,
    {
      variables: {
        handle: { type: METAOBJECT_TYPE, handle },
      },
    },
  );

  const { data } = await response.json();
  const metaobject = data?.metaobjectByHandle;

  if (!metaobject) {
    return null;
  }

  return transformMetaobject(metaobject, shop);
}

export async function getQRCodes(graphql, shop) {
  const response = await graphql(
    `
      query GetQRCodes($type: String!) {
        metaobjects(type: $type, first: 50, sortKey: "updated_at", reverse: true) {
          nodes {
            id
            handle
            createdAt
            title: field(key: "title") { jsonValue }
            product: field(key: "product") {
              jsonValue
              reference {
                ... on Product {
                  handle
                  title
                  media(first: 1) {
                    nodes {
                      preview {
                        image { url altText }
                      }
                    }
                  }
                }
              }
            }
            productVariant: field(key: "product_variant") {
              reference {
                ... on ProductVariant { id legacyResourceId }
              }
            }
            destination: field(key: "destination") { jsonValue }
            scans: field(key: "scans") { jsonValue }
          }
        }
      }
    `,
    {
      variables: { type: METAOBJECT_TYPE },
    },
  );

  const { data } = await response.json();
  const metaobjects = data?.metaobjects?.nodes ?? [];

  return Promise.all(metaobjects.map((mo) => transformMetaobject(mo, shop)));
}

async function transformMetaobject(metaobject, shop) {
  const product = metaobject.product?.reference;
  const variant = metaobject.productVariant?.reference;
  const productId = metaobject.product?.jsonValue;

  const qrCode = {
    id: metaobject.id,
    handle: metaobject.handle,
    title: metaobject.title?.jsonValue,
    productId,
    productVariantId: variant?.id,
    productHandle: product?.handle,
    productVariantLegacyId: variant?.legacyResourceId,
    destination: metaobject.destination?.jsonValue,
    scans: metaobject.scans?.jsonValue ?? 0,
    liveOn: metaobject.liveOn?.jsonValue ?? "",
    createdAt: metaobject.createdAt,
    productDeleted: productId && !product,
    productTitle: product?.title,
    productImage: product?.media?.nodes[0]?.preview?.image?.url,
    productAlt: product?.media?.nodes[0]?.preview?.image?.altText,
  };

  // A deleted product leaves nothing to build a URL from.
  qrCode.destinationUrl =
    product && variant ? getDestinationUrl(qrCode, shop) : null;
  qrCode.image = await getQRCodeImage(metaobject.handle, shop);

  return qrCode;
}
// [END get-qrcode]

// [START get-qrcode-image]
export async function getQRCodeImage(handle, shop) {
  const url = new URL(
    `/qrcodes/${handle}/scan`,
    process.env.SHOPIFY_APP_URL,
  );
  url.searchParams.set("shop", shop);
  return qrcode.toDataURL(url.href);
}
// [END get-qrcode-image]

// [START get-destination]
// [START qr-marketing.utm]
export function getQRCodeUTM(handle) {
  return {
    campaign: handle,
    medium: "qr",
    source: "qr-code-demo",
  };
}
// [END qr-marketing.utm]

// [START qr-marketing.destination-utm]
// Both destinations land on the storefront, where Shopify attribution reads
// the UTM parameters. The cart permalink keeps them through checkout.
export function getDestinationUrl(qrCode, shop) {
  let url;
  if (qrCode.destination === "product") {
    url = new URL(`/products/${qrCode.productHandle}`, `https://${shop}`);
    url.searchParams.set("variant", qrCode.productVariantLegacyId);
  } else {
    invariant(qrCode.productVariantLegacyId, "Unrecognised product variant ID");
    url = new URL(`/cart/${qrCode.productVariantLegacyId}:1`, `https://${shop}`);
  }

  const utm = getQRCodeUTM(qrCode.handle);
  url.searchParams.set("utm_campaign", utm.campaign);
  url.searchParams.set("utm_medium", utm.medium);
  url.searchParams.set("utm_source", utm.source);
  return url.href;
}
// [END qr-marketing.destination-utm]
// [END get-destination]

// [START save-qrcode]
export async function saveQRCode(handle, data, graphql) {
  const response = await graphql(
    `
      mutation UpsertQRCode($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
        metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
          metaobject { id handle }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        handle: { type: METAOBJECT_TYPE, handle },
        metaobject: {
          fields: [
            { key: "title", value: data.title },
            { key: "product", value: data.productId },
            { key: "product_variant", value: data.productVariantId },
            { key: "destination", value: data.destination },
            // Left out, the upsert keeps the stored value. Blank clears it.
            ...(data.campaign === undefined
              ? []
              : [{ key: "campaign", value: data.campaign }]),
            ...(data.liveOn === undefined
              ? []
              : [{ key: "live_on", value: data.liveOn }]),
          ],
        },
      },
    },
  );

  const { data: responseData } = await response.json();
  const { metaobjectUpsert } = responseData;

  if (metaobjectUpsert.userErrors.length) {
    throw new Error(metaobjectUpsert.userErrors[0].message);
  }

  return metaobjectUpsert.metaobject;
}
// [END save-qrcode]

// [START qr-marketing.upsert-activity]
export async function upsertMarketingActivity(handle, title, shop, graphql) {
  const remoteUrl = new URL(
    `/qrcodes/${handle}/scan`,
    process.env.SHOPIFY_APP_URL,
  );
  remoteUrl.searchParams.set("shop", shop);

  const response = await graphql(
    `
      mutation UpsertQRCodeMarketingActivity($input: MarketingActivityUpsertExternalInput!) {
        marketingActivityUpsertExternal(input: $input) {
          marketingActivity { id }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        input: {
          marketingChannelType: "REFERRAL",
          remoteId: handle,
          remoteUrl: remoteUrl.href,
          status: "ACTIVE",
          tactic: "AD",
          title,
          utm: getQRCodeUTM(handle),
        },
      },
    },
  );

  const { data } = await response.json();
  const result = data?.marketingActivityUpsertExternal;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors[0].message);
  }

  return result?.marketingActivity;
}
// [END qr-marketing.upsert-activity]

// [START qr-marketing.end-activity]
export async function endMarketingActivity(handle, shop, graphql) {
  const remoteUrl = new URL(
    `/qrcodes/${handle}/scan`,
    process.env.SHOPIFY_APP_URL,
  );
  remoteUrl.searchParams.set("shop", shop);

  const response = await graphql(
    `
      mutation EndQRCodeMarketingActivity($input: MarketingActivityUpsertExternalInput!) {
        marketingActivityUpsertExternal(input: $input) {
          marketingActivity { id }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        input: {
          marketingChannelType: "REFERRAL",
          remoteId: handle,
          remoteUrl: remoteUrl.href,
          // The title is required. The deleted activity keeps the handle as its label.
          status: "DELETED_EXTERNALLY",
          tactic: "AD",
          title: handle,
          utm: getQRCodeUTM(handle),
        },
      },
    },
  );

  const { data } = await response.json();
  const result = data?.marketingActivityUpsertExternal;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors[0].message);
  }
}
// [END qr-marketing.end-activity]

// [START delete-qrcode]
export async function deleteQRCode(id, graphql) {
  const response = await graphql(
    `
      mutation DeleteQRCode($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors { field message }
        }
      }
    `,
    {
      variables: { id },
    },
  );

  const { data } = await response.json();

  if (data.metaobjectDelete.userErrors.length) {
    throw new Error(data.metaobjectDelete.userErrors[0].message);
  }
}
// [END delete-qrcode]

// [START increment-scans]
// Read, then write. Concurrent scans can lose a count, which a sample tolerates.
export async function incrementQRCodeScans(id, currentScans, graphql) {
  const response = await graphql(
    `
      mutation IncrementScans($id: ID!, $metaobject: MetaobjectUpdateInput!) {
        metaobjectUpdate(id: $id, metaobject: $metaobject) {
          metaobject { id }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        id,
        metaobject: {
          fields: [{ key: "scans", value: String(currentScans + 1) }],
        },
      },
    },
  );
  const { data } = await response.json();
  if (data?.metaobjectUpdate?.userErrors?.length) {
    throw new Error(data.metaobjectUpdate.userErrors[0].message);
  }
}
// [END increment-scans]

// [START generate-handle]
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function generateHandle(title) {
  return `${slugify(title)}-${Date.now().toString(36)}`;
}
// [END generate-handle]

// [START validate-qrcode]
export function validateQRCode(data) {
  const errors = {};

  if (!data.title) {
    errors.title = "Title is required";
  }

  if (!data.productId) {
    errors.productId = "Product is required";
  }

  if (!data.destination) {
    errors.destination = "Destination is required";
  }

  if (Object.keys(errors).length) {
    return errors;
  }
}
// [END validate-qrcode]
