# cloudsynth-pack-baseline

A baseline set of checks for [`cloudsynth verify`](https://www.npmjs.com/package/cloudsynth).

```yaml
# cloudsynth.intent.yml
version: 1
extends:
  - cloudsynth-pack-baseline
```

```
npm i -D cloudsynth cloudsynth-pack-baseline
npx cdk synth --all
npx cloudsynth verify
```

## What it checks

| Check | |
|---|---|
| `buckets-block-public-access` | All four public-access blocks are on |
| `buckets-encrypted-at-rest` | Objects are encrypted |
| `tables-encrypted-at-rest` | DynamoDB encrypts at rest |
| `no-world-open-ssh` | Nothing opens port 22 to `0.0.0.0/0` |
| `no-world-open-rdp` | Nothing opens port 3389 to `0.0.0.0/0` |
| `databases-not-publicly-accessible` | No RDS instance is internet-reachable |
| `queues-encrypted-at-rest` | SQS uses a KMS key or SQS-managed SSE |

Each positive check sets `on-empty: pass`, so a stack with no queues is not
told it is missing one. Those report `subjects: 0`, which keeps a vacuous pass
visible instead of looking like a real result.

## Disagreeing with it

Override the id in your own file — the rest of the pack stays live and keeps
receiving updates:

```yaml
extends: [cloudsynth-pack-baseline]
checks:
  - id: buckets-encrypted-at-rest
    description: Buckets encrypt with a customer-managed key
    select: AWS::S3::Bucket
    on-empty: pass
    assert:
      BucketEncryption.ServerSideEncryptionConfiguration: present
```

Or exempt it, with a reason and ideally a date:

```yaml
checks:
  - id: buckets-block-public-access
    # ...the rest of the check as you want it...
    exempt:
      reason: Public docs bucket, tracked in PLAT-441
      until: 2026-12-31
```

## This package contains no code

No `bin`, no `main`, no `exports`, no dependencies — one YAML file, a README
and a licence. Adopting a ruleset should not mean running someone else's code
in your CI, and the packaging script asserts that nothing executable ships.

MIT.
