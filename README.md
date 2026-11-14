# Pantry food inventory

A household inventory app with barcode entry and a path to shared access across phones, computers, and a Mac mini.

## Local development

Use Node.js 22.12 or newer (`.nvmrc` points to 22). Run `npm install`, then `npm run dev`. Open the Vite address printed in the terminal. The local API saves data to `data/inventory.json`; that file is intentionally ignored by Git.

## What's here

- React pantry interface with product search, categories, low stock, add/remove actions, and recent activity.
- Barcode camera support in browsers that provide `BarcodeDetector`, plus a manual field that works with keyboard-wedge USB/Bluetooth scanners.
- Open Food Facts lookup with manual correction.
- Local Node API and JSON persistence for development.
- AWS SAM template for Cognito sign-in, API Gateway HTTP API, Lambda, DynamoDB, private S3 hosting, and CloudFront.
- Cloud builds read Cognito configuration from a deployment-generated `/runtime-config.json`; local development doesn't require AWS credentials.

## Product and cloud architecture

The browser talks to one `/api` contract. Local development sends it to the local JSON server. The hosted app sends it through CloudFront to an authenticated API Gateway route and Lambda. Cognito provides household sign-in; browsers receive user tokens and never AWS credentials. A public app client uses Cognito's SRP flow, and self-registration is disabled so the household owner adds family accounts.

The DynamoDB layout uses one household partition (`HOME#primary`) and sort-key prefixes for products, stock events, and unrecognized scans. It supports product/barcode lookup, household inventory loading, activity history, and stock updates. Stock and history writes are atomic together. Provisioned capacity starts at 2 read and 5 write units. Point-in-time recovery and deletion protection are enabled, and the table is retained on stack deletion.

This model suits a small household and key-based lookups. If expiration tracking, reporting, complex filters, or multiple homes become central, revisit the schema and compare a relational database before building those features.

## Deploy with AWS SAM

`infra/food-inventory.yaml` is an AWS SAM template. SAM defines the Lambda function, authenticated HTTP API routes, and their connection; CloudFormation still creates and manages the stack and the remaining AWS resources. The function source is bundled locally, then SAM uploads the built package to the existing artifact bucket under the `inventory-api/` prefix.

The CloudFormation execution role `PantryFoodInventoryCloudFormationExecution` and artifact bucket already exist. The first stack creation reached `ROLLBACK_COMPLETE` before any resources were created because the plain Lambda resource's `Tags` property was a map; CloudFormation expected an array of tag objects. The SAM function uses the map format SAM expects and translates it to CloudFormation's format.

When the validation finding is resolved, build the Lambda bundle, then deploy from a shell that has AWS credentials allowed to upload to the artifact bucket, create/update the stack, and pass the execution role:

```sh
npm install
npm run package:lambda
sam validate --template-file infra/food-inventory.yaml
sam build --template-file infra/food-inventory.yaml
npm run build
sam deploy \
  --template-file infra/food-inventory.yaml \
  --stack-name pantry-food-inventory \
  --region us-east-1 \
  --s3-bucket pantry-artifacts-475693412214-us-east-1-an \
  --s3-prefix inventory-api \
  --role-arn arn:aws:iam::475693412214:role/PantryFoodInventoryCloudFormationExecution \
  --capabilities CAPABILITY_IAM
```

SAM uploads the Lambda package using the credentials running `sam deploy`. CloudFormation then reads that package using its execution role. The existing execution policy currently allows reading only `inventory-api.zip`; before deploying the SAM package, update that role policy to allow `s3:GetObject` on `arn:aws:s3:::pantry-artifacts-475693412214-us-east-1-an/inventory-api/*`.

After deployment, read the `AssetsBucketName`, `UserPoolId`, and `UserPoolClientId` stack outputs. Upload the frontend and runtime Cognito settings, then invalidate CloudFront so the new app appears:

```sh
aws s3 sync dist/ s3://YOUR-ASSETS-BUCKET --delete
printf '{"userPoolId":"YOUR-USER-POOL-ID","userPoolClientId":"YOUR-CLIENT-ID"}\n' | aws s3 cp - s3://YOUR-ASSETS-BUCKET/runtime-config.json --content-type application/json
aws cloudfront create-invalidation --distribution-id YOUR-DISTRIBUTION-ID --paths '/*'
```

Create the first user in the Cognito console; self-registration is disabled. Use the `AppUrl` output to open the app.

AWS usage can incur charges. DynamoDB uses provisioned capacity within the service's published free allowance, if available on the account. S3, CloudFront, API Gateway, Lambda, Cognito, backups, logs, and data transfer also have account-specific pricing and free-tier rules. Check current pricing and billing alerts before deploying; free-tier eligibility and remaining credits could not be verified from the connected role.

## Scanner path

Camera and keyboard-wedge scanning are available now. A Wi-Fi scanner is not implemented: the right option depends on whether its firmware sends keyboard input, posts to a configurable HTTP endpoint, or speaks a vendor protocol. Once a specific model is selected, add a Mac mini listener only if its protocol needs one. The API's `/api/scans` endpoint already accepts a barcode and add/remove action, but hosted requests require Cognito authorization.
