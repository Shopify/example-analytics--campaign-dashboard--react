-- CreateTable
CREATE TABLE "ShopState" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "lastCampaignId" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "CampaignState" (
    "shop" TEXT NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "campaignGid" TEXT NOT NULL,
    "markers" TEXT NOT NULL DEFAULT '{}',
    "targets" TEXT NOT NULL DEFAULT '{}',
    "sentEvents" INTEGER,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("shop", "campaignId")
);

-- CreateTable
CREATE TABLE "CampaignLock" (
    "shop" TEXT NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,

    PRIMARY KEY ("shop", "campaignId")
);

