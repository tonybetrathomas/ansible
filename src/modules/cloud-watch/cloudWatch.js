import { CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { getAsyncContextLogger } from '../../utils/logger.js';
import { cloudWatchLogsClient } from '../../utils/awsClients.js';

const region = process.env.AWS_REGION || "us-east-1";

export async function createLogGroup(logGroupName) {
    const logger = getAsyncContextLogger();

    try {
        const command = new CreateLogGroupCommand({
          logGroupName: logGroupName,
        });
        const response = await cloudWatchLogsClient.send(command);
        logger.info(`Log group created: ${logGroupName}`);
      } catch (error) {
        if (error.name === "ResourceAlreadyExistsException") {
          logger.info(`Log group already exists: ${logGroupName}`);
        } else {
          logger.error(`Error creating log group: ${error.message}`, error.stack);
          throw new Error(error);
        }
      }

}