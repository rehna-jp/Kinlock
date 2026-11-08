use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// Placeholder (valid base58). `anchor keys sync` replaces it with your real program id.
declare_id!("DnuvWPjfZhLE3mtFkM9frcpmhAYnfhnfarJTTvj6wDeD");

const MAX_SECS: i64 = 315_360_000; // ~10 years, keeps timestamp math safe

#[program]
pub mod kinlock {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        interval: i64,
        grace: i64,
        guardian: Option<Pubkey>,
        guardian_timeout: i64,
        mint: Option<Pubkey>,
        beneficiaries: Vec<BeneficiaryInput>,
    ) -> Result<()> {
        require!(
            interval > 0 && interval <= MAX_SECS && grace >= 0 && grace <= MAX_SECS
                && guardian_timeout >= 0 && guardian_timeout <= MAX_SECS,
            KinLockError::BadTiming
        );
        require!(guardian != Some(ctx.accounts.owner.key()), KinLockError::BadGuardian);
        validate_beneficiaries(&beneficiaries)?;

        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.last_check_in = Clock::get()?.unix_timestamp;
        v.interval = interval;
        v.grace = grace;
        v.guardian = guardian;
        v.guardian_timeout = guardian_timeout;
        v.guardian_approved = false;
        v.locked = false;
        v.snapshot_lamports = 0;
        v.mint = mint;
        v.token_snapshot = 0;
        v.count = beneficiaries.len() as u8;
        v.bump = ctx.bumps.vault;
        for (i, b) in beneficiaries.iter().enumerate() {
            v.beneficiaries[i] = Beneficiary { claim_key: b.claim_key, share_bps: b.share_bps, claimed: false };
        }
        Ok(())
    }

    // Owner proves they are alive. Clears any guardian approval.
    pub fn check_in(ctx: Context<OwnerOnly>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(!v.locked, KinLockError::Locked);
        v.last_check_in = Clock::get()?.unix_timestamp;
        v.guardian_approved = false;
        Ok(())
    }

    pub fn owner_withdraw(ctx: Context<OwnerOnly>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.vault.locked, KinLockError::Locked);
        let vault_info = ctx.accounts.vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
        let remaining = vault_info
            .lamports()
            .checked_sub(amount)
            .ok_or(error!(KinLockError::Insufficient))?;
        require!(remaining >= rent_min, KinLockError::Insufficient);
        **vault_info.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;
        Ok(())
    }

    // Owner takes tokens back out of the vault (only before any claim).
    pub fn owner_withdraw_token(ctx: Context<OwnerWithdrawToken>, amount: u64) -> Result<()> {
        let v = &ctx.accounts.vault;
        require!(!v.locked, KinLockError::Locked);
        require!(v.mint == Some(ctx.accounts.mint.key()), KinLockError::BadTokenAccount);
        let owner_key = v.owner;
        let bump = v.bump;
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    // Closes the vault and returns everything (including rent) to the owner.
    // Withdraw any tokens first (the app does both in one transaction).
    pub fn cancel_vault(_ctx: Context<CancelVault>) -> Result<()> {
        Ok(())
    }

    pub fn guardian_approve(ctx: Context<GuardianApprove>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(v.guardian == Some(ctx.accounts.guardian.key()), KinLockError::NotGuardian);
        let now = Clock::get()?.unix_timestamp;
        require!(now > v.last_check_in + v.interval, KinLockError::TooEarly);
        v.guardian_approved = true;
        Ok(())
    }

    // Pays the beneficiary their share of SOL and, if the vault has a token mint,
    // their share of that token. Token accounts are passed as remaining accounts:
    // [vault_token (ATA of vault), destination_token (owned by `destination`), token_program]
    pub fn claim<'a>(ctx: Context<'a, Claim<'a>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let vault_info = ctx.accounts.vault.to_account_info();
        let vault_key = ctx.accounts.vault.key();
        let dest_key = ctx.accounts.destination.key();
        let claimant_key = ctx.accounts.claimant.key();
        let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
        require_keys_neq!(dest_key, vault_key, KinLockError::BadDestination);

        let v = &mut ctx.accounts.vault;
        let claimable_at = v.last_check_in + v.interval + v.grace;
        require!(now > claimable_at, KinLockError::NotClaimable);

        if v.guardian.is_some() {
            let timed_out = v.guardian_timeout > 0 && now > claimable_at + v.guardian_timeout;
            require!(v.guardian_approved || timed_out, KinLockError::GuardianPending);
        }

        let idx = v.beneficiaries[..v.count as usize]
            .iter()
            .position(|b| b.claim_key == claimant_key)
            .ok_or(error!(KinLockError::NotBeneficiary))?;
        require!(!v.beneficiaries[idx].claimed, KinLockError::AlreadyClaimed);

        // Token leg: validate every account before touching anything
        let mut token_accts: Option<(AccountInfo, AccountInfo, AccountInfo, u64)> = None;
        if let Some(mint) = v.mint {
            let rem = ctx.remaining_accounts;
            require!(rem.len() == 3, KinLockError::TokenAccountsMissing);
            let (vt, dt, tp) = (&rem[0], &rem[1], &rem[2]);
            require_keys_eq!(tp.key(), token::ID, KinLockError::BadTokenAccount);
            require_keys_eq!(vt.key(), get_associated_token_address(&vault_key, &mint), KinLockError::BadTokenAccount);
            require_keys_neq!(dt.key(), vt.key(), KinLockError::BadTokenAccount);
            require!(*vt.owner == token::ID && *dt.owner == token::ID, KinLockError::BadTokenAccount);
            let vacc = TokenAccount::try_deserialize(&mut &vt.try_borrow_data()?[..])?;
            let dacc = TokenAccount::try_deserialize(&mut &dt.try_borrow_data()?[..])?;
            require_keys_eq!(vacc.mint, mint, KinLockError::BadTokenAccount);
            require_keys_eq!(vacc.owner, vault_key, KinLockError::BadTokenAccount);
            require_keys_eq!(dacc.mint, mint, KinLockError::BadTokenAccount);
            require_keys_eq!(dacc.owner, dest_key, KinLockError::BadTokenAccount);
            token_accts = Some((vt.clone(), dt.clone(), tp.clone(), vacc.amount));
        }

        // Snapshot once so later claimants are not shorted by earlier payouts.
        if !v.locked {
            v.locked = true;
            v.snapshot_lamports = vault_info.lamports().saturating_sub(rent_min);
            v.token_snapshot = token_accts.as_ref().map(|t| t.3).unwrap_or(0);
        }

        let bps = v.beneficiaries[idx].share_bps as u128;
        let amount = (v.snapshot_lamports as u128 * bps / 10_000) as u64;
        let token_amount = (v.token_snapshot as u128 * bps / 10_000) as u64;
        v.beneficiaries[idx].claimed = true;
        let owner_key = v.owner;
        let bump = v.bump;

        if let Some((vt, dt, tp, _)) = token_accts {
            if token_amount > 0 {
                let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];
                token::transfer(
                    CpiContext::new_with_signer(
                        tp.key(),
                        Transfer { from: vt, to: dt, authority: vault_info.clone() },
                        &[seeds],
                    ),
                    token_amount,
                )?;
            }
        }

        **vault_info.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.destination.to_account_info().try_borrow_mut_lamports()? += amount;
        Ok(())
    }
}

fn validate_beneficiaries(b: &[BeneficiaryInput]) -> Result<()> {
    require!(!b.is_empty() && b.len() <= 2, KinLockError::BadBeneficiaries);
    require!(b.iter().all(|x| x.share_bps > 0), KinLockError::BadShares);
    let total: u32 = b.iter().map(|x| x.share_bps as u32).sum();
    require!(total == 10_000, KinLockError::BadShares);
    if b.len() == 2 {
        require!(b[0].claim_key != b[1].claim_key, KinLockError::DuplicateKey);
    }
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub last_check_in: i64,
    pub interval: i64,
    pub grace: i64,
    pub guardian: Option<Pubkey>,
    pub guardian_timeout: i64,
    pub guardian_approved: bool,
    pub locked: bool,
    pub snapshot_lamports: u64,
    pub mint: Option<Pubkey>,
    pub token_snapshot: u64,
    pub count: u8,
    pub beneficiaries: [Beneficiary; 2],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Beneficiary {
    pub claim_key: Pubkey,
    pub share_bps: u16,
    pub claimed: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BeneficiaryInput {
    pub claim_key: Pubkey,
    pub share_bps: u16,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", owner.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct OwnerWithdrawToken<'info> {
    #[account(seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelVault<'info> {
    #[account(
        mut, close = owner, has_one = owner,
        seeds = [b"vault", owner.key().as_ref()], bump = vault.bump,
        constraint = !vault.locked @ KinLockError::Locked
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct GuardianApprove<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    pub guardian: Signer<'info>,
}

// Account order matters: the relayer validates it (vault, claimant, fee_payer, destination).
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    pub claimant: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    /// CHECK: any address the beneficiary chooses; only receives lamports
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

#[error_code]
pub enum KinLockError {
    #[msg("Bad timing values")] BadTiming,
    #[msg("1 or 2 beneficiaries required")] BadBeneficiaries,
    #[msg("Shares must be > 0 and total 10000 bps")] BadShares,
    #[msg("Vault is locked")] Locked,
    #[msg("Not the guardian")] NotGuardian,
    #[msg("Too early")] TooEarly,
    #[msg("Vault not claimable yet")] NotClaimable,
    #[msg("Guardian approval pending")] GuardianPending,
    #[msg("Not a beneficiary")] NotBeneficiary,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("Insufficient funds")] Insufficient,
    #[msg("Beneficiary keys must differ")] DuplicateKey,
    #[msg("Guardian cannot be the owner")] BadGuardian,
    #[msg("Invalid destination")] BadDestination,
    #[msg("Token accounts missing")] TokenAccountsMissing,
    #[msg("Invalid token account")] BadTokenAccount,
}
