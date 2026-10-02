import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getQRCodes } from "../models/QRCode.server";
import { campaignOf, readCampaigns } from "../campaigns.server";

// [START loader]
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const [qrCodes, { campaigns }] = await Promise.all([
    getQRCodes(admin.graphql, session.shop),
    readCampaigns(admin),
  ]);

  // [START campaign-dashboard.qr-list-campaign]
  // The campaign entry holds the link. A failed read lists every code without one.
  return {
    qrCodes: qrCodes.map((qrCode) => {
      const campaign = campaignOf(campaigns, qrCode.id);
      return {
        ...qrCode,
        campaign: campaign && { id: campaign.id, title: campaign.title },
      };
    }),
  };
  // [END campaign-dashboard.qr-list-campaign]
}
// [END loader]

// [START empty]
const EmptyQRCodeState = () => (
  <s-section accessibilityLabel="Empty state section">
    <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
      <s-box maxInlineSize="200px" maxBlockSize="200px">
        <s-image
          aspectRatio="1/0.5"
          src="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          alt="A stylized graphic of a document"
        />
      </s-box>
      <s-grid justifyItems="center" maxBlockSize="450px" maxInlineSize="450px">
        <s-heading>Create unique QR codes for your products</s-heading>
        <s-paragraph>
          Allow customers to scan codes and buy products using their phones.
        </s-paragraph>
        <s-stack
          gap="small-200"
          justifyContent="center"
          padding="base"
          paddingBlockEnd="none"
          direction="inline"
        >
          <s-button href="/app/qrcodes/new" variant="primary">
            Create QR code
          </s-button>
        </s-stack>
      </s-grid>
    </s-grid>
  </s-section>
);
// [END empty]

// [START truncate]
function truncate(str, { length = 25 } = {}) {
  if (!str) return "";
  if (str.length <= length) return str;
  return str.slice(0, length) + "…";
}
// [END truncate]

// [START table]
const QRTable = ({ qrCodes }) => (
  <s-section padding="none" accessibilityLabel="QR code table">
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Title</s-table-header>
        <s-table-header>Product</s-table-header>
        <s-table-header>Campaign</s-table-header>
        <s-table-header>Date created</s-table-header>
        <s-table-header>Scans</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {qrCodes.map((qrCode) => (
          <QRTableRow key={qrCode.handle} qrCode={qrCode} />
        ))}
      </s-table-body>
    </s-table>
  </s-section>
);
// [END table]

// [START row]
const QRTableRow = ({ qrCode }) => (
  <s-table-row id={qrCode.handle}>
    <s-table-cell>
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-clickable
          href={`/app/qrcodes/${qrCode.handle}`}
          accessibilityLabel={`Edit the ${qrCode.title} QR code`}
          border="base"
          borderRadius="base"
          overflow="hidden"
          inlineSize="20px"
          blockSize="20px"
        >
          {qrCode.productImage ? (
            <s-image objectFit="cover" src={qrCode.productImage}></s-image>
          ) : (
            <s-icon type="image" />
          )}
        </s-clickable>
        <s-link href={`/app/qrcodes/${qrCode.handle}`}>
          {truncate(qrCode.title)}
        </s-link>
      </s-stack>
    </s-table-cell>
    <s-table-cell>
      {/* [START deleted] */}
      {qrCode.productDeleted ? (
        <s-badge icon="alert-diamond" tone="critical">
          Product has been deleted
        </s-badge>
      ) : (
        truncate(qrCode.productTitle)
      )}
      {/* [END deleted] */}
    </s-table-cell>
    <s-table-cell>
      {qrCode.campaign ? (
        <s-link href={`/app/campaigns/${qrCode.campaign.id}`}>
          {truncate(qrCode.campaign.title)}
        </s-link>
      ) : (
        "None"
      )}
    </s-table-cell>
    <s-table-cell>
      {new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(
        new Date(qrCode.createdAt),
      )}
    </s-table-cell>
    <s-table-cell>{qrCode.scans}</s-table-cell>
  </s-table-row>
);
// [END row]

export default function Index() {
  const { qrCodes } = useLoaderData();

  // [START page]
  return (
    <s-page heading="QR codes">
      <s-link slot="secondary-actions" href="/app/qrcodes/new">
        Create QR code
      </s-link>
      {qrCodes.length === 0 ? (
        <EmptyQRCodeState />
      ) : (
        <QRTable qrCodes={qrCodes} />
      )}
    </s-page>
  );
  // [END page]
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
