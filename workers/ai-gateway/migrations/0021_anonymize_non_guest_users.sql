-- Privacy decision 3: remove the name and email of every non-guest user row.
-- The row itself stays, so foreign keys and the account counts do not change.
-- email is UNIQUE and NOT NULL, so each row gets a unique invalid address.
-- image is nullable, so it is cleared. Guests are identified as in admin.ts,
-- and the synthetic admin-operator principal (0019) is excluded.
UPDATE user
SET name = 'Anonymized user',
    email = 'anonymized-' || id || '@kakeimatch.invalid',
    image = NULL
WHERE id != 'admin-operator'
  AND id NOT IN (SELECT user_id FROM guest_devices);
