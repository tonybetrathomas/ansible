import { spawn } from 'child_process';
import path from 'path';
import { readdir } from 'fs/promises';
import { downloadFromS3 } from '../s3/s3.js';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import fs from 'fs';
import { getAsyncContextLogger } from '../../utils/logger.js';
import { getSsmParameter } from '../../utils/configLoader.js';
import { secretsManagerClient } from '../../utils/awsClients.js';

const region = process.env.AWS_REGION || "us-east-1";

// Constants for error messages and status
const DB_DEPLOYMENT_NOT_ENABLED_MESSAGE = "DB Deployment not enabled via this channel";
const DB_CONFIG_NOT_FOUND_MESSAGE = "DB Config Not found for";
const MISSING_REQUIRED_CONFIG_MESSAGE = 'Missing required configuration: SQL_SERVER_NAME, SQL_DATABASE_NAME, or DACPAC_PATH.';
const SQLPACKAGE_NOT_FOUND_ERROR = `'sqlpackage' command not found. Ensure it's installed and in your system's PATH.`;

/**
 * Deploys a DACPAC package using the sqlpackage utility.
 * @param {object} options - Deployment options.
 * @param {string} options.serverName - Target SQL Server name/address.
 * @param {string} options.databaseName - Target database name.
 * @param {string} options.dacpacPath - Path to the .dacpac file.
 * @param {boolean} [options.useSqlAuth=false] - Use SQL Server authentication.
 * @param {string} [options.sqlUser] - SQL Server username (required if useSqlAuth is true).
 * @param {string} [options.sqlPassword] - SQL Server password (required if useSqlAuth is true).
 * @param {object} [options.sqlCmdVariables={}] - Key-value pairs for SQLCMD variables.
 * @param {boolean} [options.blockOnPossibleDataLoss=true] - Block deployment if data loss might occur.
 * @param {boolean} [options.trustServerCertificate=false] - Set TrustServerCertificate=True.
 * @param {string[]} [options.additionalParams=[]] - Array of additional sqlpackage arguments.
 * @returns {Promise<void>} A promise that resolves on successful deployment or rejects on error.
 */
async function deployDacpac({
    serverName,
    databaseName,
    dacpacPath,
    useSqlAuth = false,
    sqlUser,
    sqlPassword,
    sqlCmdVariables = {},
    blockOnPossibleDataLoss = false,
    trustServerCertificate = true,
    additionalParams = []
}) {
    const logger = getAsyncContextLogger();
    return new Promise((resolve, reject) => {
        logger.info(`Starting DACPAC deployment to ${databaseName} on ${serverName}...`);
        logger.info(`Source DACPAC: ${dacpacPath}`);
        const fileName = dacpacPath.split("/").pop();
        const deploymentStatus ={status: '' , message : '',file :fileName, db:databaseName};

        const args = [
            '/Action:Publish',
            `/SourceFile:${path.resolve(dacpacPath)}`, // Ensure absolute path
            `/TargetServerName:${serverName}`,
            `/TargetDatabaseName:${databaseName}`,
            `/p:BlockOnPossibleDataLoss=${blockOnPossibleDataLoss}`,
           // `/p:VerifyDeployment=True`,
            `/Diagnostics:true`,
            `/DiagnosticsLevel:Warning`,
        // --- Handle Authentication ---
        ];

        // --- Handle Authentication ---
        if (useSqlAuth) {
            if (!sqlUser || !sqlPassword) {
                return reject(new Error('SQL User and Password are required for SQL Authentication.'));
            }
            logger.info(`Using SQL Authentication (User: ${sqlUser}).`);
            args.push(`/TargetUser:${sqlUser}`);
            args.push(`/TargetPassword:${sqlPassword}`);
            // Or use /TargetConnectionString if preferred, but be mindful of escaping
        }
        else {
            logger.info('Using Integrated Security / Default Credentials (Windows Auth or Azure AD Integrated).');
        }

        // --- Optional Parameters ---
        if (trustServerCertificate) {
            args.push('/TargetTrustServerCertificate:True');
            logger.info('Setting TrustServerCertificate=True.');
        }

        // Add SQLCMD variables
        for (const [key, value] of Object.entries(sqlCmdVariables)) {
            args.push(`/v:${key}=${value}`);
        }
        if (Object.keys(sqlCmdVariables).length > 0) {
            logger.info(`Applying SQLCMD variables: ${JSON.stringify(sqlCmdVariables)}`);
        }

        // Add any other custom parameters
        args.push(...additionalParams);
        if (additionalParams.length > 0) {
            logger.info(`Adding additional parameters: ${additionalParams.join(' ')}`);
        }


      //  logger.info(`Executing: sqlpackage ${args.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`); // Log the command safely

        // Spawn the sqlpackage process
        const sqlPackageProcess = spawn('sqlpackage', args, {
            stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin, pipe stdout/stderr
            shell: false // More secure and reliable not to use shell
        });

        let stdoutData = '';
        let stderrData = '';

        // Capture stdout
        sqlPackageProcess.stdout.on('data', (data) => {
            const output = data.toString();
            process.stdout.write(output); // Stream output live
            stdoutData += output;
        });

        // Capture stderr
        sqlPackageProcess.stderr.on('data', (data) => {
            const output = data.toString();
            process.stderr.write(output); // Stream errors live
            stderrData += output;
        });

        // Handle errors during spawning
        sqlPackageProcess.on('error', (err) => {
            logger.error('Failed to start sqlpackage process.');
            // Common issue: sqlpackage not found in PATH
            if (err.code === 'ENOENT') {
                reject(new Error(`${SQLPACKAGE_NOT_FOUND_ERROR}. Error: ${err.message}`));
            } else {
                reject(err);
            }
        });

       
        // Handle process exit
        sqlPackageProcess.on('close', (code) => {
            logger.info(`Sqlpackage process exited with code ${code}`);
            if (code === 0) {
                logger.info(`DACPAC deployment completed successfully.`);
                deploymentStatus.message = stdoutData;
                deploymentStatus.status = 'Sucess';
                resolve(deploymentStatus);
            } else {
                // Combine logs for the error message
                let errorMessage = `Sqlpackage deployment failed with exit code ${code}.`;
                if (stderrData) {
                    errorMessage += `\nStderr:\n${stderrData}`;
                }
                // Sometimes important errors might appear on stdout
                if (stdoutData && !stderrData) { // Include stdout if stderr is empty
                    errorMessage += `\nStdout:\n${stdoutData}`;
                }
                deploymentStatus.message = errorMessage;
                deploymentStatus.status = 'Failed';
                // You might want to parse stdoutData/stderrData further for specific error messages
                reject(deploymentStatus);
            }
        });
    });
}

// --- Main Execution Logic ---
export async function deployToDB(catalogData,customerName,tenantName) {
    const logger = getAsyncContextLogger();

    if (!fs.existsSync('configFiles/dbFiles')) {
        fs.mkdirSync('configFiles/dbFiles', { recursive: true });
    }

    const fileName = catalogData.dacpac.file.split('/').pop(); 
    await downloadFromS3(catalogData.dacpac.bucket, catalogData.dacpac.file, `configFiles/dbFiles/${fileName}`);


    const resolvedPath = path.resolve('configFiles/dbFiles');
    const entries = await readdir(resolvedPath);

    if (!entries.length) { // Simplified check
        logger.info("(Directory is empty)");
    } else {
        entries.forEach(entry => logger.info(`- ${entry}`));
    }


    const parameterName = `/${customerName}/${tenantName}/framework/${catalogData.region.toUpperCase()}/CD/${catalogData.product.toUpperCase()}/DATABASE/METADATA`;
    let configData ={};
    try{
         configData = await getSsmParameter(parameterName);
    }catch(err){
         logger.error(`Failed to retrieve SSM parameter: ${parameterName}`);
         return [{ message:DB_DEPLOYMENT_NOT_ENABLED_MESSAGE,status:'NA', file: fileName, db:'NA'}];
    }

    logger.info(`Parameter name: ${parameterName} , value : ${JSON.stringify(configData)}`);

    const dbPointer = catalogData.dacpac.targetDB || catalogData.product.toUpperCase();

    if(!configData.config){
        logger.info(`Config undefined for ${catalogData.product} skipping db deployment`);
        return [{ message:DB_DEPLOYMENT_NOT_ENABLED_MESSAGE,status:'NA', file: fileName, db:'NA'}];
    }

    logger.info(`Db pointer :${dbPointer} config :${JSON.stringify(configData.config.HPP[dbPointer])}`);
    

    if(!configData.config[tenantName]?.[dbPointer]){
        return  [{message: `${DB_CONFIG_NOT_FOUND_MESSAGE} ${dbPointer}` , status:'NA', file: fileName, db:'NA'}];
    }

    const dbRefs = configData.config[tenantName][dbPointer]['db-ref'];
    logger.info(`DbRefs:  ${JSON.stringify(dbRefs)}`);
    const deploymentStatus =[];
    for(const dbRef of dbRefs){
    
        const dbDtls = configData.DBMap[dbRef];
        logger.info(`Db ref: ${dbRef} ,details: ${JSON.stringify(dbDtls)}`);

        let secretValue ;
        let response ={}
        try{
            const command = new GetSecretValueCommand({ SecretId: `/${customerName}/${tenantName}/framework/${catalogData.region.toUpperCase()}/CD/${catalogData.product.toUpperCase()}/DATABASE/PASSWORD` });
            response = await secretsManagerClient.send(command);
            secretValue = JSON.parse(response.SecretString)[dbDtls.dbPassKey];
        }catch(err){
            logger.error(`Failed to retrieve secret for db deployment : ${err.message} /${customerName}/${tenantName}/framework/${catalogData.region.toUpperCase()}/CD/${catalogData.product.toUpperCase()}/DATABASE/PASSWORD`);
            deploymentStatus.push( {message: `Failed to retrieve secret for db deployment : ${err.message}` , status:'Failed', file: fileName, db: dbDtls.dbName} );
            return deploymentStatus;
        }
        if(!secretValue){
            logger.warn(`Secret key ${dbDtls.dbPassKey} not found in Secrets Manager response available keys : ${Object.keys(JSON.parse(response.SecretString))}`);
        }
        
        const config = {
            serverName: `${dbDtls.hostName},${dbDtls.port}`, // e.g., localhost, server\\instance, Azure SQL FQDN
            databaseName: dbDtls.dbName,
            dacpacPath: `configFiles/dbFiles/${fileName}`, // Relative or absolute path

            useSqlAuth: true, // Set to 'true' to use SQL Auth
            sqlUser: dbDtls.dbUser,
            sqlPassword: secretValue, // Highly sensitive!

            // --- Optional sqlpackage parameters ---
            sqlCmdVariables: { 
                // VariableName: 'VariableValue',
                // AnotherVar: 'AnotherValue'
            },
            blockOnPossibleDataLoss: false, // Default: true (safer). Set to 'false' to allow potential data loss.
            trustServerCertificate: true,
            additionalParams: ['/p:CommandTimeout=600']
        };

        
        try {
            // Validate essential config
            if (!config.serverName || !config.databaseName || !config.dacpacPath) {
                throw new Error(MISSING_REQUIRED_CONFIG_MESSAGE);
            }

            deploymentStatus.push(await deployDacpac(config));

            //deploymentStatus.push({status: 'NA explicit skipping ' , message : '',file :dacpacPath});
            logger.info('\nDeployment script finished.');
        } catch (error) {
            logger.error('\n--- Deployment Script Error ---');
            logger.error(`Db deployment error :${error.message}`);
            logger.error(`Db deployment error stack :${error.stack}`); 
            deploymentStatus.push( {message: error.message , status:'Failed', file: fileName, db: dbDtls.dbName} );
        }
        logger.info(`End of dacpac deployment : ${JSON.stringify(deploymentStatus)}`);
    }

    return deploymentStatus;
    

}

