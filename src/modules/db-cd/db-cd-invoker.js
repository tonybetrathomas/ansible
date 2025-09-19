import axios from 'axios';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
//import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { changePath } from '../s3/s3.js';
import { getAsyncContextLogger } from '../../utils/logger.js';
//import { ssmClient } from '../../utils/awsClients.js';
import { getSsmParameter } from '../../utils/configLoader.js';
import { secretsManagerClient } from '../../utils/awsClients.js';

const region = process.env.AWS_REGION || "us-east-1";
//const secretsManagerClient = new SecretsManagerClient({ region });
//const ssmClient = new SSMClient({ region });


export async function invokeDBPipeline(catalogData) {
    const logger = getAsyncContextLogger();
    const personalAccessToken = 'your-personal-access-token'; // Consider retrieving this from Secrets Manager or SSM
    try {
       
        const templateParameters = {
            param1: 'value1',
            param2: 'value2'
        };

        const config = {
            headers: {
                'Authorization': `Basic ${Buffer.from(`:${personalAccessToken}`).toString('base64')}`,
                'Content-Type': 'application/json'
            }
        };

        const parameterName = `/USTHP/HPP/framework/${catalogData.region.toUpperCase()}/CD/${catalogData.product.toUpperCase()}/DATABASE/METADATA`;

        // const pipelineJsonCommand = new GetParameterCommand({
        //     Name: parameterName,
        //     WithDecryption: false,
        // });
        // const pipelineJsonParameter = await ssmClient.send(pipelineJsonCommand);
        // const configData = pipelineJsonParameter.Parameter.Value;
        const configData = await getSsmParameter(parameterName);

        logger.info(`Parameter name: ${parameterName} , value : ${JSON.stringify(configData)}`);

        //const response = await axios.post(`${serverUrl}/${collection}/${project}/_apis/projects?api-version=6.0`, templateParameters, config);
        //logger.info(response.data);
        return null;
        


         //TODO: to be removed and above code to be enabled  
        //  const dacpacFilePathParts =  catalogData.dacpac.file.split("/");
        //  const newPath = `${catalogData.region}/${catalogData.product}/${dacpacFilePathParts[dacpacFilePathParts.length-1]}`;

        //  const status = await changePath(catalogData.dacpac.bucket,catalogData.dacpac.file,newPath)

    } catch (error) {
        logger.error(`Error invoking DB pipeline : ${error.message}`, error.stack);
        //throw error;
    }
    
   
        


}