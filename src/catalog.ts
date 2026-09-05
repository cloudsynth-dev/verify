/**
 * The check catalog — one list, two consumers.
 *
 * `cloudsynth init` reads it to propose checks for the resource types a repo
 * actually has, and `cloudsynth-pack-baseline`'s YAML is GENERATED from the
 * subset marked `baseline`. Those were always going to be two copies of nearly
 * the same set of rules, and two copies drift: the pack would gain a hint the
 * starter file never got, or `init` would suggest a check whose published
 * version had been fixed. A test asserts the generated pack file matches this
 * list byte for byte, so the drift is impossible rather than merely
 * discouraged.
 *
 * ── Why `yaml` is authored text and not an object ────────────────────────────
 * Each entry carries the YAML a user will read, verbatim. Serialising an
 * IntentCheck object back to YAML would produce a valid file with none of the
 * comments, the hints' phrasing, or the property ordering that makes it worth
 * reading — and the whole premise of this format is that a human maintains it.
 * The cost is that the text and the metadata beside it could disagree, so the
 * catalog test parses every entry and checks they do not.
 *
 * Every check here was run against a real 765-resource CDK app before being
 * listed. Nothing is included on the strength of sounding sensible.
 */

export interface CatalogEntry {
  id: string;
  /** CloudFormation types this is about — what `init` matches against. */
  types: string[];
  /** Included in cloudsynth-pack-baseline. */
  baseline: boolean;
  /** The check exactly as it should appear in a file, indented for `checks:`. */
  yaml: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'buckets-block-public-access',
    types: ['AWS::S3::Bucket'],
    baseline: true,
    yaml: `  - id: buckets-block-public-access
    description: Every bucket blocks all four forms of public access
    hint: "Set blockPublicAccess: BlockPublicAccess.BLOCK_ALL."
    select: AWS::S3::Bucket
    on-empty: pass
    assert:
      PublicAccessBlockConfiguration.BlockPublicAcls: true
      PublicAccessBlockConfiguration.BlockPublicPolicy: true
      PublicAccessBlockConfiguration.IgnorePublicAcls: true
      PublicAccessBlockConfiguration.RestrictPublicBuckets: true
`,
  },
  {
    id: 'buckets-encrypted-at-rest',
    types: ['AWS::S3::Bucket'],
    baseline: true,
    yaml: `  - id: buckets-encrypted-at-rest
    description: Every bucket encrypts objects at rest
    hint: "Set encryption: BucketEncryption.S3_MANAGED (or KMS)."
    select: AWS::S3::Bucket
    on-empty: pass
    assert:
      BucketEncryption: present
`,
  },
  {
    id: 'buckets-enforce-ssl',
    types: ['AWS::S3::BucketPolicy'],
    baseline: true,
    yaml: `  - id: buckets-enforce-ssl
    description: Every bucket policy denies plaintext HTTP access
    hint: "Set enforceSSL: true on the Bucket."
    select:
      - type: AWS::S3::BucketPolicy
        items: PolicyDocument.Statement
    quantifier: any
    on-empty: pass
    assert:
      Effect: Deny
      Condition.Bool.aws:SecureTransport: "false"
`,
  },
  {
    id: 'tables-encrypted-at-rest',
    types: ['AWS::DynamoDB::Table'],
    baseline: true,
    yaml: `  - id: tables-encrypted-at-rest
    description: Every DynamoDB table encrypts data at rest
    hint: "Set encryption: TableEncryption.AWS_MANAGED."
    select: AWS::DynamoDB::Table
    on-empty: pass
    assert:
      SSESpecification.SSEEnabled: true
`,
  },
  {
    id: 'tables-point-in-time-recovery',
    types: ['AWS::DynamoDB::Table'],
    baseline: false,
    yaml: `  - id: tables-point-in-time-recovery
    description: Every DynamoDB table has point-in-time recovery enabled
    hint: "Set pointInTimeRecovery: true."
    select: AWS::DynamoDB::Table
    on-empty: pass
    assert:
      PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled: true
`,
  },
  {
    id: 'databases-storage-encrypted',
    types: ['AWS::RDS::DBInstance'],
    baseline: true,
    yaml: `  - id: databases-storage-encrypted
    description: Every RDS instance encrypts its storage
    hint: "Set storageEncrypted: true."
    select: AWS::RDS::DBInstance
    on-empty: pass
    assert:
      StorageEncrypted: true
`,
  },
  {
    id: 'databases-deletion-protection',
    types: ['AWS::RDS::DBInstance'],
    baseline: true,
    yaml: `  - id: databases-deletion-protection
    description: Every RDS instance has deletion protection on
    hint: "Set deletionProtection: true."
    select: AWS::RDS::DBInstance
    on-empty: pass
    assert:
      DeletionProtection: true
`,
  },
  {
    // Both places an ingress rule can live. Checking only one of them is the
    // most common way this rule is written wrongly.
    id: 'no-world-open-ssh',
    types: ['AWS::EC2::SecurityGroup', 'AWS::EC2::SecurityGroupIngress'],
    baseline: true,
    yaml: `  - id: no-world-open-ssh
    description: No security group allows SSH from 0.0.0.0/0
    hint: "Scope the peer to a CIDR you control, or use SSM Session Manager."
    select:
      - type: AWS::EC2::SecurityGroup
        items: SecurityGroupIngress
      - type: AWS::EC2::SecurityGroupIngress
    quantifier: none
    assert:
      CidrIp: 0.0.0.0/0
      FromPort: 22
`,
  },
  {
    id: 'no-world-open-rdp',
    types: ['AWS::EC2::SecurityGroup', 'AWS::EC2::SecurityGroupIngress'],
    baseline: true,
    yaml: `  - id: no-world-open-rdp
    description: No security group allows RDP from 0.0.0.0/0
    hint: "Scope the peer to a CIDR you control."
    select:
      - type: AWS::EC2::SecurityGroup
        items: SecurityGroupIngress
      - type: AWS::EC2::SecurityGroupIngress
    quantifier: none
    assert:
      CidrIp: 0.0.0.0/0
      FromPort: 3389
`,
  },
  {
    id: 'databases-not-publicly-accessible',
    types: ['AWS::RDS::DBInstance'],
    baseline: true,
    yaml: `  - id: databases-not-publicly-accessible
    description: No RDS instance is reachable from the internet
    hint: "Set publiclyAccessible: false and place it in private subnets."
    select: AWS::RDS::DBInstance
    quantifier: none
    assert:
      PubliclyAccessible: true
`,
  },
  {
    // Two legitimate shapes — a customer KMS key, or SQS-managed encryption —
    // and asserting either one alone is simply wrong.
    id: 'queues-encrypted-at-rest',
    types: ['AWS::SQS::Queue'],
    baseline: true,
    yaml: `  - id: queues-encrypted-at-rest
    description: Every SQS queue encrypts messages at rest
    hint: "Set encryption: QueueEncryption.KMS_MANAGED, or SQS_MANAGED."
    select: AWS::SQS::Queue
    on-empty: pass
    any-of:
      - KmsMasterKeyId: present
      - SqsManagedSseEnabled: true
`,
  },
  {
    // Deliberately described as being about log groups, not about functions.
    // An earlier draft called this "every Lambda has log retention" while
    // selecting AWS::Logs::LogGroup, which examined the 8 groups that existed
    // and said nothing about the other 72 functions — and passed.
    id: 'log-groups-set-explicit-retention',
    types: ['AWS::Logs::LogGroup'],
    baseline: true,
    yaml: `  - id: log-groups-set-explicit-retention
    description: Every log group sets an explicit retention period
    hint: "Pass logRetention / retention on the construct that creates it."
    select: AWS::Logs::LogGroup
    on-empty: pass
    assert:
      RetentionInDays: present
`,
  },
  {
    id: 'no-policy-grants-all-actions',
    types: ['AWS::IAM::Policy', 'AWS::IAM::Role'],
    baseline: true,
    yaml: `  - id: no-policy-grants-all-actions
    description: No IAM policy statement grants Action "*" on Resource "*"
    hint: "Name the actions, or scope the resource. Both being * is admin."
    select:
      - type: AWS::IAM::Policy
        items: PolicyDocument.Statement
      - type: AWS::IAM::Role
        items: Policies
    quantifier: none
    on-empty: pass
    assert:
      Action: "*"
      Resource: "*"
`,
  },
  {
    id: 'api-methods-require-authorization',
    types: ['AWS::ApiGateway::Method'],
    baseline: false,
    yaml: `  - id: api-methods-require-authorization
    description: Every non-OPTIONS API method requires authorization
    hint: "Set authorizationType, or attach an authorizer, on the method."
    select: AWS::ApiGateway::Method
    on-empty: pass
    where:
      HttpMethod: { not: OPTIONS }
    assert:
      AuthorizationType: { not: NONE }
`,
  },
  {
    id: 'cloudfront-viewer-protocol-not-allow-all',
    types: ['AWS::CloudFront::Distribution'],
    baseline: true,
    yaml: `  - id: cloudfront-viewer-protocol-not-allow-all
    description: Every CloudFront behaviour redirects or requires HTTPS
    hint: "Set viewerProtocolPolicy to REDIRECT_TO_HTTPS or HTTPS_ONLY."
    select: AWS::CloudFront::Distribution
    on-empty: pass
    assert:
      DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy:
        not: allow-all
`,
  },
  {
    id: 'cloudfront-minimum-tls-1-2',
    types: ['AWS::CloudFront::Distribution'],
    baseline: true,
    yaml: `  - id: cloudfront-minimum-tls-1-2
    description: Every CloudFront distribution requires TLS 1.2 or better
    hint: "Set minimumProtocolVersion to TLSv1.2_2021 on the viewer certificate."
    select: AWS::CloudFront::Distribution
    on-empty: pass
    where:
      DistributionConfig.ViewerCertificate.MinimumProtocolVersion: present
    assert:
      DistributionConfig.ViewerCertificate.MinimumProtocolVersion:
        - not: TLSv1
        - not: TLSv1_2016
        - not: TLSv1.1_2016
        - not: SSLv3
`,
  },
  {
    id: 'cloudfront-access-logging',
    types: ['AWS::CloudFront::Distribution'],
    baseline: false,
    yaml: `  - id: cloudfront-access-logging
    description: Every CloudFront distribution writes access logs
    hint: "Pass logBucket, or enableLogging, on the Distribution."
    select: AWS::CloudFront::Distribution
    on-empty: pass
    assert:
      DistributionConfig.Logging: present
`,
  },
  {
    id: 'cognito-password-length',
    types: ['AWS::Cognito::UserPool'],
    baseline: true,
    yaml: `  - id: cognito-password-length
    description: User pools require passwords of at least 12 characters
    hint: "Set passwordPolicy.minLength to 12 or more."
    select: AWS::Cognito::UserPool
    on-empty: pass
    assert:
      Policies.PasswordPolicy.MinimumLength:
        at-least: 12
`,
  },
  {
    id: 'cognito-password-classes',
    types: ['AWS::Cognito::UserPool'],
    baseline: false,
    yaml: `  - id: cognito-password-classes
    description: User pool passwords require a number and a symbol
    hint: "Set passwordPolicy.requireDigits and requireSymbols to true."
    select: AWS::Cognito::UserPool
    on-empty: pass
    assert:
      Policies.PasswordPolicy.RequireNumbers: true
      Policies.PasswordPolicy.RequireSymbols: true
`,
  },
  {
    id: 'cognito-mfa-not-off',
    types: ['AWS::Cognito::UserPool'],
    baseline: false,
    yaml: `  - id: cognito-mfa-not-off
    description: User pools do not disable MFA outright
    hint: "Set mfa to Mfa.OPTIONAL or Mfa.REQUIRED."
    select: AWS::Cognito::UserPool
    on-empty: pass
    where:
      MfaConfiguration: present
    assert:
      MfaConfiguration:
        not: "OFF"
`,
  },
  {
    id: 'secrets-rotation-has-a-schedule',
    types: ['AWS::SecretsManager::RotationSchedule'],
    baseline: false,
    yaml: `  - id: secrets-rotation-has-a-schedule
    description: Every rotation schedule actually states a rotation interval
    hint: "Set automaticallyAfter, or a schedule expression, on the rotation."
    select: AWS::SecretsManager::RotationSchedule
    on-empty: pass
    any-of:
      - RotationRules.AutomaticallyAfterDays: present
      - RotationRules.ScheduleExpression: present
`,
  },
  {
    id: 'kms-key-rotation-enabled',
    types: ['AWS::KMS::Key'],
    baseline: true,
    yaml: `  - id: kms-key-rotation-enabled
    description: Every customer-managed KMS key rotates annually
    hint: "Set enableKeyRotation: true on the Key."
    select: AWS::KMS::Key
    on-empty: pass
    assert:
      EnableKeyRotation: true
`,
  },
  {
    id: 'vpc-has-flow-logs',
    types: ['AWS::EC2::VPC', 'AWS::EC2::FlowLog'],
    baseline: false,
    yaml: `  - id: vpc-has-flow-logs
    description: The app records VPC flow logs somewhere
    hint: "Call addFlowLog() on the Vpc."
    select: AWS::EC2::FlowLog
    quantifier: any
    assert:
      ResourceType: present
`,
  },
  {
    id: 'waf-webacl-has-default-action',
    types: ['AWS::WAFv2::WebACL'],
    baseline: true,
    yaml: `  - id: waf-webacl-has-default-action
    description: Every Web ACL states what to do with unmatched requests
    hint: "Set defaultAction to allow or block explicitly."
    select: AWS::WAFv2::WebACL
    on-empty: pass
    assert:
      DefaultAction: present
`,
  },
  {
    id: 'waf-logging-configured',
    types: ['AWS::WAFv2::LoggingConfiguration'],
    baseline: false,
    yaml: `  - id: waf-logging-configured
    description: Every Web ACL logging configuration names a destination
    hint: "Pass logDestinationConfigs when configuring WAF logging."
    select: AWS::WAFv2::LoggingConfiguration
    on-empty: pass
    assert:
      LogDestinationConfigs: present
`,
  },
  {
    id: 'sns-topics-encrypted',
    types: ['AWS::SNS::Topic'],
    baseline: true,
    yaml: `  - id: sns-topics-encrypted
    description: Every SNS topic encrypts messages at rest
    hint: "Pass masterKey on the Topic."
    select: AWS::SNS::Topic
    on-empty: pass
    assert:
      KmsMasterKeyId: present
`,
  },
  {
    id: 'alb-http-listener-redirects',
    types: ['AWS::ElasticLoadBalancingV2::Listener'],
    baseline: true,
    yaml: `  - id: alb-http-listener-redirects
    description: Every plain-HTTP listener redirects rather than serving
    hint: "Give the HTTP listener a ListenerAction.redirect to HTTPS."
    select: AWS::ElasticLoadBalancingV2::Listener
    on-empty: pass
    where:
      Protocol: HTTP
    assert:
      DefaultActions.0.Type: redirect
`,
  },
  {
    id: 'alb-drops-invalid-headers',
    types: ['AWS::ElasticLoadBalancingV2::LoadBalancer'],
    baseline: false,
    yaml: `  - id: alb-drops-invalid-headers
    description: Every load balancer drops invalid HTTP headers
    hint: "Set desyncMitigationMode, or the drop_invalid_header_fields attribute, to true."
    select:
      - type: AWS::ElasticLoadBalancingV2::LoadBalancer
        items: LoadBalancerAttributes
    quantifier: any
    on-empty: pass
    assert:
      Key: routing.http.drop_invalid_header_fields.enabled
      Value: "true"
`,
  },
  {
    id: 'ecs-no-privileged-containers',
    types: ['AWS::ECS::TaskDefinition'],
    baseline: true,
    yaml: `  - id: ecs-no-privileged-containers
    description: No container runs privileged
    hint: "Remove privileged: true from the container definition."
    select:
      - type: AWS::ECS::TaskDefinition
        items: ContainerDefinitions
    quantifier: none
    on-empty: pass
    assert:
      Privileged: true
`,
  },
  {
    id: 'efs-encrypted',
    types: ['AWS::EFS::FileSystem'],
    baseline: true,
    yaml: `  - id: efs-encrypted
    description: Every EFS file system encrypts at rest
    hint: "Set encrypted: true on the FileSystem."
    select: AWS::EFS::FileSystem
    on-empty: pass
    assert:
      Encrypted: true
`,
  },
  {
    id: 'elasticache-encrypted-at-rest',
    types: ['AWS::ElastiCache::ReplicationGroup'],
    baseline: true,
    yaml: `  - id: elasticache-encrypted-at-rest
    description: Every ElastiCache replication group encrypts at rest
    hint: "Set atRestEncryptionEnabled: true."
    select: AWS::ElastiCache::ReplicationGroup
    on-empty: pass
    assert:
      AtRestEncryptionEnabled: true
`,
  },
  {
    id: 'elasticache-encrypted-in-transit',
    types: ['AWS::ElastiCache::ReplicationGroup'],
    baseline: false,
    yaml: `  - id: elasticache-encrypted-in-transit
    description: Every ElastiCache replication group encrypts in transit
    hint: "Set transitEncryptionEnabled: true."
    select: AWS::ElastiCache::ReplicationGroup
    on-empty: pass
    assert:
      TransitEncryptionEnabled: true
`,
  },
  {
    id: 'kinesis-stream-encrypted',
    types: ['AWS::Kinesis::Stream'],
    baseline: true,
    yaml: `  - id: kinesis-stream-encrypted
    description: Every Kinesis stream encrypts records at rest
    hint: "Set encryption: StreamEncryption.KMS on the Stream."
    select: AWS::Kinesis::Stream
    on-empty: pass
    assert:
      StreamEncryption: present
`,
  },
  {
    id: 'step-functions-logging',
    types: ['AWS::StepFunctions::StateMachine'],
    baseline: false,
    yaml: `  - id: step-functions-logging
    description: Every state machine configures logging
    hint: "Pass logs: { destination, level } on the StateMachine."
    select: AWS::StepFunctions::StateMachine
    on-empty: pass
    assert:
      LoggingConfiguration: present
`,
  },
];

/** Catalog entries relevant to a set of resource types actually present. */
export function entriesForTypes(present: Set<string>): CatalogEntry[] {
  return CATALOG.filter((e) => e.types.some((t) => present.has(t)));
}

export const BASELINE_ENTRIES = CATALOG.filter((e) => e.baseline);
