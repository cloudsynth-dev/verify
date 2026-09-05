import type { TemplateJson } from '../engine/index.js';

/**
 * A passing and a failing template for every catalog rule.
 *
 * The failing half is the one that matters. A rule that cannot fail is the
 * failure mode this product exists to avoid: `init` would emit it as an active
 * check, the reader would see a green run, and the rule would be asserting
 * nothing at all. Each BAD fixture is its GOOD counterpart with exactly the
 * asserted property broken, so the guard is proven to bite by construction
 * rather than by anyone remembering to check.
 *
 * Kept beside the catalog rather than as JSON files because they are read
 * together: adding a rule without a pair fails a test that compares the key
 * sets.
 */

const bucket = (props: Record<string, unknown>): TemplateJson => ({
  Resources: { Uploads: { Type: 'AWS::S3::Bucket', Properties: props } },
});

const BLOCK_ALL = {
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
};

const bucketPolicy = (statement: unknown): TemplateJson => ({
  Resources: {
    Policy: {
      Type: 'AWS::S3::BucketPolicy',
      Properties: { PolicyDocument: { Statement: [statement] } },
    },
  },
});

const table = (props: Record<string, unknown>): TemplateJson => ({
  Resources: { Store: { Type: 'AWS::DynamoDB::Table', Properties: props } },
});

const rds = (props: Record<string, unknown>): TemplateJson => ({
  Resources: { Db: { Type: 'AWS::RDS::DBInstance', Properties: props } },
});

const sg = (ingress: unknown[]): TemplateJson => ({
  Resources: {
    Sg: { Type: 'AWS::EC2::SecurityGroup', Properties: { SecurityGroupIngress: ingress } },
  },
});

const queue = (props: Record<string, unknown>): TemplateJson => ({
  Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: props } },
});

const logGroup = (props: Record<string, unknown>): TemplateJson => ({
  Resources: { Logs: { Type: 'AWS::Logs::LogGroup', Properties: props } },
});

const policy = (statement: unknown): TemplateJson => ({
  Resources: {
    P: {
      Type: 'AWS::IAM::Policy',
      Properties: { PolicyDocument: { Statement: [statement] } },
    },
  },
});

const method = (props: Record<string, unknown>): TemplateJson => ({
  Resources: { M: { Type: 'AWS::ApiGateway::Method', Properties: props } },
});

const DENY_INSECURE = {
  Effect: 'Deny',
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
};


const distribution = (config: Record<string, unknown>): TemplateJson => ({
  Resources: { Cdn: { Type: 'AWS::CloudFront::Distribution', Properties: { DistributionConfig: config } } },
});
const CDN_OK = {
  DefaultCacheBehavior: { ViewerProtocolPolicy: 'redirect-to-https' },
  ViewerCertificate: { MinimumProtocolVersion: 'TLSv1.2_2021' },
  Logging: { Bucket: 'logs' },
};

const userPool = (props: Record<string, unknown>): TemplateJson => ({
  Resources: { Pool: { Type: 'AWS::Cognito::UserPool', Properties: props } },
});
const POOL_OK = {
  Policies: {
    PasswordPolicy: { MinimumLength: 12, RequireNumbers: true, RequireSymbols: true },
  },
  MfaConfiguration: 'OPTIONAL',
};

const one = (type: string, props: Record<string, unknown>): TemplateJson => ({
  Resources: { R: { Type: type, Properties: props } },
});

const listener = (props: Record<string, unknown>): TemplateJson =>
  one('AWS::ElasticLoadBalancingV2::Listener', props);
const loadBalancer = (attributes: unknown[]): TemplateJson =>
  one('AWS::ElasticLoadBalancingV2::LoadBalancer', { LoadBalancerAttributes: attributes });
const taskDefinition = (containers: unknown[]): TemplateJson =>
  one('AWS::ECS::TaskDefinition', { ContainerDefinitions: containers });

export const GOOD: Record<string, TemplateJson> = {
  'buckets-block-public-access': bucket({ PublicAccessBlockConfiguration: BLOCK_ALL }),
  'buckets-encrypted-at-rest': bucket({ BucketEncryption: { on: true } }),
  'buckets-enforce-ssl': bucketPolicy(DENY_INSECURE),
  'tables-encrypted-at-rest': table({ SSESpecification: { SSEEnabled: true } }),
  'tables-point-in-time-recovery': table({
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  }),
  'databases-storage-encrypted': rds({ StorageEncrypted: true }),
  'databases-deletion-protection': rds({ DeletionProtection: true }),
  'databases-not-publicly-accessible': rds({ PubliclyAccessible: false }),
  'no-world-open-ssh': sg([{ CidrIp: '10.0.0.0/8', FromPort: 22 }]),
  'no-world-open-rdp': sg([{ CidrIp: '10.0.0.0/8', FromPort: 3389 }]),
  'queues-encrypted-at-rest': queue({ SqsManagedSseEnabled: true }),
  'log-groups-set-explicit-retention': logGroup({ RetentionInDays: 30 }),
  'no-policy-grants-all-actions': policy({ Action: 's3:GetObject', Resource: '*' }),
  'api-methods-require-authorization': method({
    HttpMethod: 'GET',
    AuthorizationType: 'COGNITO_USER_POOLS',
  }),
  'cloudfront-viewer-protocol-not-allow-all': distribution(CDN_OK),
  'cloudfront-minimum-tls-1-2': distribution(CDN_OK),
  'cloudfront-access-logging': distribution(CDN_OK),
  'cognito-password-length': userPool(POOL_OK),
  'cognito-password-classes': userPool(POOL_OK),
  'cognito-mfa-not-off': userPool(POOL_OK),
  'secrets-rotation-has-a-schedule': one('AWS::SecretsManager::RotationSchedule', { RotationRules: { AutomaticallyAfterDays: 30 } }),
  'kms-key-rotation-enabled': one('AWS::KMS::Key', { EnableKeyRotation: true }),
  'vpc-has-flow-logs': one('AWS::EC2::FlowLog', { ResourceType: 'VPC' }),
  'waf-webacl-has-default-action': one('AWS::WAFv2::WebACL', { DefaultAction: { Block: {} } }),
  'waf-logging-configured': one('AWS::WAFv2::LoggingConfiguration', { LogDestinationConfigs: ['arn:x'] }),
  'sns-topics-encrypted': one('AWS::SNS::Topic', { KmsMasterKeyId: 'alias/aws/sns' }),
  'alb-http-listener-redirects': listener({ Protocol: 'HTTP', DefaultActions: [{ Type: 'redirect' }] }),
  'alb-drops-invalid-headers': loadBalancer([{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }]),
  'ecs-no-privileged-containers': taskDefinition([{ Name: 'app', Privileged: false }]),
  'efs-encrypted': one('AWS::EFS::FileSystem', { Encrypted: true }),
  'elasticache-encrypted-at-rest': one('AWS::ElastiCache::ReplicationGroup', { AtRestEncryptionEnabled: true, TransitEncryptionEnabled: true }),
  'elasticache-encrypted-in-transit': one('AWS::ElastiCache::ReplicationGroup', { AtRestEncryptionEnabled: true, TransitEncryptionEnabled: true }),
  'kinesis-stream-encrypted': one('AWS::Kinesis::Stream', { StreamEncryption: { EncryptionType: 'KMS' } }),
  'step-functions-logging': one('AWS::StepFunctions::StateMachine', { LoggingConfiguration: { Level: 'ALL' } }),
};

export const BAD: Record<string, TemplateJson> = {
  // One of the four is off — the case a check asserting only BlockPublicAcls
  // would wave through.
  'buckets-block-public-access': bucket({
    PublicAccessBlockConfiguration: { ...BLOCK_ALL, RestrictPublicBuckets: false },
  }),
  'buckets-encrypted-at-rest': bucket({}),
  // Allows rather than denies plaintext.
  'buckets-enforce-ssl': bucketPolicy({ Effect: 'Allow' }),
  'tables-encrypted-at-rest': table({ SSESpecification: { SSEEnabled: false } }),
  'tables-point-in-time-recovery': table({
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
  }),
  'databases-storage-encrypted': rds({ StorageEncrypted: false }),
  'databases-deletion-protection': rds({ DeletionProtection: false }),
  'databases-not-publicly-accessible': rds({ PubliclyAccessible: true }),
  'no-world-open-ssh': sg([{ CidrIp: '0.0.0.0/0', FromPort: 22 }]),
  'no-world-open-rdp': sg([{ CidrIp: '0.0.0.0/0', FromPort: 3389 }]),
  'queues-encrypted-at-rest': queue({}),
  'log-groups-set-explicit-retention': logGroup({}),
  // Both wildcards. Either alone is legitimate; together it is admin.
  'no-policy-grants-all-actions': policy({ Action: '*', Resource: '*' }),
  'api-methods-require-authorization': method({ HttpMethod: 'GET', AuthorizationType: 'NONE' }),
  'cloudfront-viewer-protocol-not-allow-all': distribution({ ...CDN_OK, DefaultCacheBehavior: { ViewerProtocolPolicy: 'allow-all' } }),
  'cloudfront-minimum-tls-1-2': distribution({ ...CDN_OK, ViewerCertificate: { MinimumProtocolVersion: 'TLSv1' } }),
  'cloudfront-access-logging': distribution({ DefaultCacheBehavior: CDN_OK.DefaultCacheBehavior, ViewerCertificate: CDN_OK.ViewerCertificate }),
  'cognito-password-length': userPool({ ...POOL_OK, Policies: { PasswordPolicy: { MinimumLength: 8, RequireNumbers: true, RequireSymbols: true } } }),
  'cognito-password-classes': userPool({ ...POOL_OK, Policies: { PasswordPolicy: { MinimumLength: 12, RequireNumbers: true, RequireSymbols: false } } }),
  'cognito-mfa-not-off': userPool({ ...POOL_OK, MfaConfiguration: 'OFF' }),
  'secrets-rotation-has-a-schedule': one('AWS::SecretsManager::RotationSchedule', { RotationRules: {} }),
  'kms-key-rotation-enabled': one('AWS::KMS::Key', { EnableKeyRotation: false }),
  'vpc-has-flow-logs': one('AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16' }),
  'waf-webacl-has-default-action': one('AWS::WAFv2::WebACL', { Name: 'acl' }),
  'waf-logging-configured': one('AWS::WAFv2::LoggingConfiguration', { ResourceArn: 'arn:x' }),
  'sns-topics-encrypted': one('AWS::SNS::Topic', { TopicName: 'events' }),
  'alb-http-listener-redirects': listener({ Protocol: 'HTTP', DefaultActions: [{ Type: 'forward' }] }),
  'alb-drops-invalid-headers': loadBalancer([{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'false' }]),
  'ecs-no-privileged-containers': taskDefinition([{ Name: 'app', Privileged: true }]),
  'efs-encrypted': one('AWS::EFS::FileSystem', { Encrypted: false }),
  'elasticache-encrypted-at-rest': one('AWS::ElastiCache::ReplicationGroup', { AtRestEncryptionEnabled: false, TransitEncryptionEnabled: true }),
  'elasticache-encrypted-in-transit': one('AWS::ElastiCache::ReplicationGroup', { AtRestEncryptionEnabled: true, TransitEncryptionEnabled: false }),
  'kinesis-stream-encrypted': one('AWS::Kinesis::Stream', { Name: 'events' }),
  'step-functions-logging': one('AWS::StepFunctions::StateMachine', { StateMachineName: 'flow' }),
};
