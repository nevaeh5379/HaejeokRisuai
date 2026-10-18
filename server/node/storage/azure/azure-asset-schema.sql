-- Azure SQL Asset Storage schema (reference)
-- Tables used by AzureSqlAssetStorage in assetStorage.cjs.
-- The init() method runs an equivalent IF NOT EXISTS batch automatically,
-- so this file is reference/documentation only.
--
-- asset_files        : original asset blobs keyed by their hex-encoded path
-- asset_thumbnails  : generated webp thumbnails keyed by asset_key + size
--
-- VARBINARY(MAX) supports up to 2 GiB per row, far exceeding typical asset
-- sizes (avatars, emotion images, audio). The free Azure SQL tier offers
-- 32 GiB per database which is plenty for personal asset collections.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'asset_files')
BEGIN
    CREATE TABLE asset_files (
        asset_key NVARCHAR(512) NOT NULL CONSTRAINT PK_asset_files PRIMARY KEY,
        content VARBINARY(MAX) NOT NULL,
        content_type NVARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
        size BIGINT NOT NULL DEFAULT 0,
        mtime DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'asset_thumbnails')
BEGIN
    CREATE TABLE asset_thumbnails (
        asset_key NVARCHAR(512) NOT NULL,
        width INT NOT NULL,
        height INT NOT NULL,
        content VARBINARY(MAX) NOT NULL,
        content_type NVARCHAR(128) NOT NULL DEFAULT 'image/webp',
        size BIGINT NOT NULL DEFAULT 0,
        mtime DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_asset_thumbnails PRIMARY KEY (asset_key, width, height)
    );
END