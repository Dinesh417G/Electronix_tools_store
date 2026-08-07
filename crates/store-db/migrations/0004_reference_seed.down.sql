-- Only the seeded codes are removed; any reason the shop added itself stays.
delete from reason_codes
 where code in (
   'NEW_JOB', 'BREAKAGE', 'WEAR', 'TRIAL', 'REWORK',
   'PURCHASE', 'RETURN_FROM_SHOP', 'FOUND'
 );
