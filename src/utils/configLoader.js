import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient } from "./awsClients.js";
import { getAsyncContextLogger } from "./logger.js";

/**
 * Fetches and parses a parameter from AWS SSM Parameter Store.
 * @param {string} parameterName - The name of the parameter to fetch.
 * @param {boolean} [withDecryption=false] - Whether to decrypt the parameter value.
 * @returns {Promise<object>} The parsed JSON value of the parameter.
 * @throws {Error} If the parameter is not found or parsing fails.
 */
export async function getSsmParameter(parameterName, withDecryption = false) {
    const logger = getAsyncContextLogger();
    try {
        const command = new GetParameterCommand({
            Name: parameterName,
            WithDecryption: withDecryption,
        });
        const response = await ssmClient.send(command);
        if (!response.Parameter || !response.Parameter.Value) {
            throw new Error(`SSM Parameter '${parameterName}' not found or has no value.`);
        }
        return JSON.parse(response.Parameter.Value);
    } catch (error) {
        logger.error(`Error fetching SSM parameter '${parameterName}': ${error.message}`, error.stack);
        throw error;
    }
}
