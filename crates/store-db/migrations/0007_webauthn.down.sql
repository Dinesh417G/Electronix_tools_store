alter table sessions drop constraint if exists sessions_identity_source_matches_punch;
alter table sessions drop column if exists identity_source;
drop table if exists webauthn_challenges;
drop table if exists webauthn_credentials;
