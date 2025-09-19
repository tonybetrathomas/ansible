import { S3 } from "@aws-sdk/client-s3";
import fs from "fs";
import { writeFileToS3 } from '../s3/s3.js';
import { getAsyncContextLogger } from '../../utils/logger.js';

export async function generateEnvFiles(commonConfig, envSpecificConfig, serviceInfo, customerName, tenantName) {
  const logger = getAsyncContextLogger();

  logger.info(`CommonConfig: ${JSON.stringify(commonConfig)}`);
  logger.info(`EnvSpecificConfig: ${JSON.stringify(envSpecificConfig)}`);

  let commonEnv = '';
  let envSpecificEnv = '';

  for (const variableName in commonConfig.variables) {
    if (commonConfig.variables.hasOwnProperty(variableName)) {
      const variable = commonConfig.variables[variableName];
      if (variable!=null && (variable.reference == undefined || variable.reference == null)) {
        if(typeof variable === 'object'){
          logger.info(`Variable value : ${JSON.stringify(variable)}`);
          commonEnv = commonEnv + variableName + '=' + JSON.stringify(variable) + '\n';
        }else{
          commonEnv = commonEnv + variableName + '=' + variable + '\n';
        }
        
      }else{
        logger.warn(`Null value for direct value :: key: ${variableName}, value ${variable} `);
      }
    }
  }

  if (envSpecificConfig?.variables) {
    for (const variableName in envSpecificConfig.variables) {
      if (envSpecificConfig.variables.hasOwnProperty(variableName)) {
        const variable = envSpecificConfig.variables[variableName];
        if (variable!=null && (variable.reference == undefined || variable.reference == null)) {
          if(typeof variable === 'object'){
            logger.info(`Variable value : ${JSON.stringify(variable)}`);
            envSpecificEnv = envSpecificEnv + variableName + '=' + JSON.stringify(variable) + '\n';
          }else{
            envSpecificEnv = envSpecificEnv + variableName + '=' + variable + '\n';
          }
        }else{
          logger.warn(`Null value for direct value :: key: ${variableName}, value ${variable} `);
        }
      }
    }
  }
  logger.info(`Region spec env file :${envSpecificEnv}`);
  logger.info(`Common spec env file :${commonEnv}`);

  if (!fs.existsSync('configFiles/envFiles')) {
    fs.mkdirSync('configFiles/envFiles', { recursive: true });
  }

  fs.writeFile(`configFiles/envFiles/${serviceInfo.serviceName}.common.env`, commonEnv, function (err) {
    if (err) throw err;
  });

  writeFileToS3(serviceInfo.configbucket, `environments/${serviceInfo.product}/${serviceInfo.serviceName}/${serviceInfo.releaseIdentifier}/${serviceInfo.serviceName}.common.env`, `configFiles/envFiles/${serviceInfo.serviceName}.common.env`);

  fs.writeFile(`configFiles/envFiles/${serviceInfo.serviceName}.${serviceInfo.region.toLowerCase()}.env`, envSpecificEnv, function (err) {
    if (err) throw err;
  });

  writeFileToS3(serviceInfo.configbucket, `environments/${serviceInfo.product}/${serviceInfo.serviceName}/${serviceInfo.releaseIdentifier}/${serviceInfo.serviceName}.${serviceInfo.region.toLowerCase()}.env`, `configFiles/envFiles/${serviceInfo.serviceName}.${serviceInfo.region.toLowerCase()}.env`);


}