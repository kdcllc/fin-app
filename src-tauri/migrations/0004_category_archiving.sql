-- Migration 4 — category archive support for management UX.
ALTER TABLE categories
ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));

-- Speeds active-category picker/list ordering by archived status then name.
CREATE INDEX idx_categories_archived_name ON categories (archived, name, id);
