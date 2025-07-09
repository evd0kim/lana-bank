mod helpers;

use authz::dummy::{DummyPerms, DummySubject};
use cala_ledger::{CalaLedger, CalaLedgerConfig};
use cloud_storage::{Storage, config::StorageConfig};
use core_accounting::CoreAccounting;
use document_storage::DocumentStorage;
use helpers::{action, object};
use job::{JobExecutorConfig, Jobs};

#[tokio::test]
async fn test_latest_document_for_ledger_account_id() -> anyhow::Result<()> {
    let (accounting, chart_ref) = prepare_test().await?;

    // Create a test ledger account
    let ledger_account = accounting
        .find_ledger_account_by_code(&DummySubject, &chart_ref, "1".to_string())
        .await?
        .expect("Ledger account should exist");

    // Test case 1: No CSV documents exist yet
    let latest_csv = accounting
        .csvs()
        .latest_document_for_ledger_account_id(&DummySubject, ledger_account.id)
        .await?;

    assert!(
        latest_csv.is_none(),
        "Should return None when no CSV documents exist"
    );

    // Test case 2: Create first CSV document
    let first_csv = accounting
        .csvs()
        .create_ledger_account_csv(&DummySubject, ledger_account.id)
        .await?;

    let latest_csv = accounting
        .csvs()
        .latest_document_for_ledger_account_id(&DummySubject, ledger_account.id)
        .await?;

    assert!(latest_csv.is_some(), "Should return the first CSV document");
    let latest = latest_csv.unwrap();
    assert_eq!(
        latest.id, first_csv.id,
        "Latest CSV should be the first one created"
    );

    assert_eq!(
        uuid::Uuid::from(latest.reference_id),
        uuid::Uuid::from(ledger_account.id),
        "CSV should reference the correct ledger account"
    );

    // Wait a bit to ensure different timestamps
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Test case 3: Create second CSV document
    let second_csv = accounting
        .csvs()
        .create_ledger_account_csv(&DummySubject, ledger_account.id)
        .await?;

    let latest_csv = accounting
        .csvs()
        .latest_document_for_ledger_account_id(&DummySubject, ledger_account.id)
        .await?;

    assert!(latest_csv.is_some(), "Should return the second CSV document");

    let latest = latest_csv.unwrap();

    assert_eq!(
        latest.id, second_csv.id,
        "Latest CSV should be the second one created"
    );
    assert_ne!(
        latest.id, first_csv.id,
        "Latest CSV should not be the first one anymore"
    );

    // Verify timestamp ordering
    assert!(
        latest.created_at() >= first_csv.created_at(),
        "Latest CSV should have a timestamp >= first CSV"
    );

    // Wait a bit more
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Test case 4: Create third CSV document
    let third_csv = accounting
        .csvs()
        .create_ledger_account_csv(&DummySubject, ledger_account.id)
        .await?;

    let latest_csv = accounting
        .csvs()
        .latest_document_for_ledger_account_id(&DummySubject, ledger_account.id)
        .await?;

    assert!(latest_csv.is_some(), "Should return the third CSV document");
    let latest = latest_csv.unwrap();
    assert_eq!(
        latest.id, third_csv.id,
        "Latest CSV should be the third one created"
    );

    // Verify it's not any of the earlier ones
    assert_ne!(latest.id, first_csv.id);
    assert_ne!(latest.id, second_csv.id);

    // Test case 5: Test with a different ledger account (should return None)
    let different_account = accounting
        .find_ledger_account_by_code(&DummySubject, &chart_ref, "2".to_string())
        .await?
        .expect("Different ledger account should exist");

    let latest_csv_different = accounting
        .csvs()
        .latest_document_for_ledger_account_id(&DummySubject, different_account.id)
        .await?;

    assert!(
        latest_csv_different.is_none(),
        "Should return None for account with no CSV documents"
    );

    // Test case 6: Create CSV for different account and verify isolation
    let different_csv = accounting
        .csvs()
        .create_ledger_account_csv(&DummySubject, different_account.id)
        .await?;

    let latest_csv_different = accounting
        .csvs()
        .latest_document_for_ledger_account_id(&DummySubject, different_account.id)
        .await?;

    assert!(latest_csv_different.is_some());
    assert_eq!(
        latest_csv_different.unwrap().id,
        different_csv.id,
        "Should return the CSV for the different account"
    );

    // Verify original account still returns the third CSV
    let latest_csv_original = accounting
        .csvs()
        .latest_document_for_ledger_account_id(&DummySubject, ledger_account.id)
        .await?;

    assert_eq!(
        latest_csv_original.unwrap().id,
        third_csv.id,
        "Original account should still return its latest CSV"
    );

    Ok(())
}

// Helper function to set up test environment
async fn prepare_test() -> anyhow::Result<(
    CoreAccounting<DummyPerms<action::DummyAction, object::DummyObject>>,
    String,
)> {
    use rand::Rng;

    let pool = helpers::init_pool().await?;
    let cala_config = CalaLedgerConfig::builder()
        .pool(pool.clone())
        .exec_migrations(false)
        .build()?;
    let cala = CalaLedger::init(cala_config).await?;
    let authz = DummyPerms::<action::DummyAction, object::DummyObject>::new();
    let journal_id = helpers::init_journal(&cala).await?;

    let storage = Storage::new(&StorageConfig::default());
    let document_storage = DocumentStorage::new(&pool, &storage);
    let jobs = Jobs::new(&pool, JobExecutorConfig::default());

    let accounting = CoreAccounting::new(&pool, &authz, &cala, journal_id, document_storage, &jobs);
    let chart_ref = format!("ref-{:08}", rand::rng().random_range(0..10000));
    let chart = accounting
        .chart_of_accounts()
        .create_chart(&DummySubject, "Test chart".to_string(), chart_ref.clone())
        .await?;

    // Create a basic chart of accounts for testing
    let import = r#"
        1,,,Assets
        2,,,Liabilities
        "#;
    let chart_id = chart.id;
    accounting
        .chart_of_accounts()
        .import_from_csv(&DummySubject, chart_id, import)
        .await?;

    Ok((accounting, chart_ref))
}