create table vaults (
  vault text primary key,
  owner text not null,
  owner_name text not null,
  owner_email text not null,
  guardian text,
  guardian_email text,
  warned_for bigint,
  created_at timestamptz default now()
);

create table beneficiaries (
  token text primary key,
  vault text not null references vaults(vault) on delete cascade,
  name text not null,
  email text not null,
  claim_key text not null unique,
  share_bps int not null,
  blob jsonb not null,
  notified_for bigint
);
create index on beneficiaries(vault);

-- RLS on with NO policies: the public/anon key can read nothing.
-- Only the server (service role key) can touch these tables.
alter table vaults enable row level security;
alter table beneficiaries enable row level security;
