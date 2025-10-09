-- Align chat attachment metadata with v5 storage helpers.
-- Adds the canonical storage path so we can reissue signed URLs when needed.

alter table chat_attachments
  add column if not exists storage_path text;

create index if not exists idx_chat_attachments_storage_path
  on chat_attachments(storage_path);

