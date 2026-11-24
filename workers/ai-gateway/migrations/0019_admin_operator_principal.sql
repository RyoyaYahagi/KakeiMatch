-- Dedicated non-login principal for Cloudflare Access admin AI analysis metering.
INSERT OR IGNORE INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
VALUES ('admin-operator', 'Admin Operator', 'operator@kakeimatch.invalid', 0, NULL, 0, 0);
