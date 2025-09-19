import { GetCallerIdentityCommand } from "@aws-sdk/client-sts"; 
import { getAsyncContextLogger } from '../../utils/logger.js';
import { stsClient } from '../../utils/awsClients.js';

const region = process.env.AWS_REGION || "us-east-1"; 
const command = new GetCallerIdentityCommand({});

export const subcriptionInfo = await stsClient.send(command);