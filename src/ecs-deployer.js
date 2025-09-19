import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { readYamlFromS3 } from './modules/s3/s3.js';
import { generateEnvFiles } from './modules/utils/envfileCreator.js';
import { generateCloudFormation } from './modules/cft/cloudformationCreator.js';
import { createOrUpdateStack } from './modules/cft/cloudFormation.js';
import { findStackByResource } from './modules/cft/resourceFinder.js';
import { updateECSTaskAndService, describeEcsService, deleteEcsService, checkServiceStatus, updateServiceInstance, checkDeploymentStatus } from './modules/ecs/ecs.js';
import { invokeDBPipeline } from './modules/db-cd/db-cd-invoker.js';
import { deployToDB } from "./modules/db-cd/dacpacDeployer.js";
import { sentNotification } from "./modules/notification/mailNotification.js";
import { deleteTgWithArn, getTargetGroupDetails } from './modules/loadbalancer/TargetGroupHandler.js';
import { dropALBListenerMapping } from './modules/loadbalancer/elb.js';
import { getLogger, getAsyncContextLogger, asyncLocalStorage } from './utils/logger.js'; // Import both for setup and access
import { getSsmParameter } from './utils/configLoader.js';
const region = process.env.AWS_REGION || "us-east-1";

const DEPLOY_MODE_CLEANUP_TG = 'cleanupTg';
const DEPLOY_MODE_CLEANUP = 'cleanup';
const DEPLOY_MODE_STOP = 'stop';
const DEPLOY_MODE_START = 'start';
const SERVICE_STACK_PREFIX = 'ECS-Service-';

const DEFAULT_CUSTOMER_NAME = 'USTHP';
const DEFAULT_TENANT_NAME = 'HPP';

(async () => {
    const runId = Date.now().toString(); // Generate a unique run ID;
    const directoryPath = process.argv[2];
    console.log(`directoryPath : ${directoryPath}`);
    // Initialize the root logger and run the entire deployment process within its AsyncLocalStorage context
    const mainLogger = getLogger(runId, 'MainDeployment');
    asyncLocalStorage.run(mainLogger, () => deployer(directoryPath, runId));
})();

async function deployer(directoryPath, runId) {
    const logger = getAsyncContextLogger(); // Retrieve logger from context
    try {
        logger.info(`Starting ECS deployment process... path ${directoryPath}`);
        const catalogs = getCatelogFiles(directoryPath);

        for (const catalog of catalogs) {
            // Create a child logger for each catalog and run its processing within its context
            const filePath = path.join(directoryPath, catalog);
            const fileVerificationStatus = validateSignature(filePath);
            logger.info(`Signature validation status for ${catalog} : ${fileVerificationStatus}`);
            const yamlData = fs.readFileSync(filePath, 'utf8');
            const catalogInfo = getSortedCatelogData(yamlData);
            const catalogData = catalogInfo.data || catalogInfo;
            const catalogHeader = catalogInfo.header;
            let CUSTOMER_NAME = DEFAULT_CUSTOMER_NAME;
            let TENANT_NAME = DEFAULT_TENANT_NAME

            let childRunId = `Catalog:${catalog}`;

            if (catalogHeader) {
                if (catalogHeader.runId) {
                    childRunId = `${childRunId}-${catalogHeader.runId}`;
                }
                if (catalogHeader.customer) {
                    logger.info(`Customer found in catalog ${catalogHeader.customer}`);
                    CUSTOMER_NAME = catalogHeader.customer;

                    if (catalogHeader.tenant) {
                        logger.info(`Tenant found in catalog ${catalogHeader.tenant}`);
                        TENANT_NAME = catalogHeader.tenant;
                    }
                }
            }

            const catalogChildLogger = getLogger(runId, childRunId);
            asyncLocalStorage.run(catalogChildLogger, async () => {

                const catalogLogger = getAsyncContextLogger();

                if (catalogInfo.data) {
                    catalogLogger.info(`Catalog in preferred mode`);
                    catalogLogger.info(`Header info : ${JSON.stringify(catalogHeader)}`);
                } else {
                    catalogLogger.info(`Catalog in legacy mode`);
                }

                const deploymentStatus = [];

                catalogLogger.info(`Catalog data: ${JSON.stringify(catalogData)}`);
                if (catalogHeader?.mode &&
                    [DEPLOY_MODE_CLEANUP_TG, DEPLOY_MODE_CLEANUP, DEPLOY_MODE_STOP, DEPLOY_MODE_START].includes(catalogHeader.mode)) {

                    catalogLogger.info(`In clean-up mode`);
                    for (const serviceCatalogData of catalogData) {
                        const msDeploymentStatus = await cleanUpService(serviceCatalogData,  catalogHeader.mode);
                        deploymentStatus.push(msDeploymentStatus);
                    }
                } else {
                    catalogLogger.info(`In create/update mode`);
                    for (const serviceCatalogData of catalogData) {
                        const msDeploymentStatus = await deployService(serviceCatalogData, CUSTOMER_NAME, TENANT_NAME);
                        deploymentStatus.push(msDeploymentStatus);
                    }
                }
                // validate health
                const isOptimisticHealthCheck = false;//configData?.OptimisticHealthCheck?.[catalogData[0].region] ?? false;
                catalogLogger.info(`HealthCheck mode isOptimisticHealthCheck :${isOptimisticHealthCheck}`);
                const combinedStatus = await updateHealthStatus(deploymentStatus, isOptimisticHealthCheck);
                sentNotification(combinedStatus, catalogData, catalog, CUSTOMER_NAME, TENANT_NAME);
            });
        }
    } catch (error) {
        logger.error(`Deployment failed: ${error.message}`, error.stack);
    }
}

function getCatelogFiles(directoryPath) {
    const logger = getAsyncContextLogger();
    logger.info(`Reading catalog files from ${directoryPath}`);
    const files = fs.readdirSync(directoryPath);
    const catalogs = files.filter(file => file.endsWith("-catalog.yml"));
    logger.info(`Found catalog files: ${catalogs.join(', ')}`);
    return catalogs;
}


function validateSignature(filePath) {
    let status = false;
    return true;
}



function initializeCleanupDeploymentStatus(serviceCatalogData) {
    return {
        service: serviceCatalogData.serviceName, region: serviceCatalogData.region ? serviceCatalogData.region.toUpperCase() : '',
        product: serviceCatalogData.product.toUpperCase(),
        app: { cluster: '', service: '', deploymentStatus: {}, healthStatus: {} }, db: []
    };
}

async function updateServiceInstanceCount(ecsService, cluster, serviceName, instanceCount) {
    const logger = getAsyncContextLogger();
    return await updateServiceInstance(ecsService, cluster, serviceName, instanceCount);
}

async function deleteTargetGroupAndListener(ecsService) {
    const logger = getAsyncContextLogger();
    if (ecsService.loadBalancers?.length > 0) {
        const tgArn = ecsService.loadBalancers[0].targetGroupArn;
        const tgDetails = await getTargetGroupDetails(tgArn);
        logger.info(`Tg dtsl :${JSON.stringify(tgDetails)}`);
        const containerPort = ecsService.loadBalancers[0].containerPort;

        if (tgDetails.TargetGroups?.[0]?.LoadBalancerArns?.length > 0) {
            const albArn = tgDetails.TargetGroups[0].LoadBalancerArns[0];
            logger.info(`Listener to be dropped ${albArn} ,${containerPort}`);
            await dropALBListenerMapping(albArn, containerPort);
        } else {
            logger.info(`No ALB's mapped to TG`);
        }
        await deleteTgWithArn(tgArn);
    } else {
        logger.info(`Tg not found for service ${ecsService.serviceName} in ${ecsService.clusterArn}`);
    }
}

async function deleteTgOnly(serviceCatalogData, deploymentStatus) {
    const logger = getAsyncContextLogger();
    logger.info('Dropping Tg');
    const tgArn = serviceCatalogData.tgArn;
    const port = serviceCatalogData.port;
    const tgDetails = await getTargetGroupDetails(tgArn);

    logger.info(`Tg dtsl :${JSON.stringify(tgDetails)}`);
    const containerPort = port;
    if (tgDetails.TargetGroups?.[0]?.LoadBalancerArns?.length > 0) {
        const albArn = tgDetails.TargetGroups[0].LoadBalancerArns[0];
        logger.info(`Listener to be dropped ${albArn} ,${containerPort}`);
        await dropALBListenerMapping(albArn, containerPort);
    } else {
        logger.info(`No ALB's mapped to TG`);
    }
    await deleteTgWithArn(tgArn);
    deploymentStatus.app.deploymentStatus = { updatedState: 'NA', status: `Tg and Mapping Removed` };
}

async function handleEcsServiceCleanup(serviceCatalogData, mode, deploymentStatus) {
    const logger = getAsyncContextLogger();
    const cluster = serviceCatalogData.cluster;
    const regionPart = serviceCatalogData.region ? `-${serviceCatalogData.region.toLowerCase()}` : '';
    const serviceName = `${serviceCatalogData.serviceName}${regionPart}`;
    deploymentStatus.app.cluster = cluster;
    deploymentStatus.app.service = serviceName;
    logger.info(`Ecs service :${serviceName} in ${mode}`);
    const ecsService = await describeEcsService(cluster, serviceName);
    logger.info(`Ecs service :${JSON.stringify(ecsService)}`);

    if (ecsService) {
        const instanceCount = (mode === DEPLOY_MODE_START) ? 1 : 0;
        const updateStatus = await updateServiceInstanceCount(ecsService, cluster, serviceName, instanceCount);
        deploymentStatus.app.deploymentStatus = updateStatus;

        if (mode === DEPLOY_MODE_CLEANUP) {
            await deleteTargetGroupAndListener(ecsService);
            await deleteEcsService(cluster, serviceName);
        }
    } else {
        deploymentStatus.app.deploymentStatus = { updatedState: 'NA', status: `Failed- ${serviceName} Not Found` };
    }
}

async function cleanUpService(serviceCatalogData, mode) {
    const logger = getAsyncContextLogger();
    const deploymentStatus = initializeCleanupDeploymentStatus(serviceCatalogData);

    logger.info(`Mode : ${mode}`);

    if (serviceCatalogData.cluster) {
        await handleEcsServiceCleanup(serviceCatalogData, mode, deploymentStatus);
    } else {
        if (mode === DEPLOY_MODE_CLEANUP_TG) {
            await deleteTgOnly(serviceCatalogData, deploymentStatus);
        } else {
            deploymentStatus.app.deploymentStatus = { updatedState: 'NA', status: `Failed- Cluster Not Defined` };
        }
    }
    return deploymentStatus;
}


async function updateHealthStatus(deploymentStatus, isOptimisticHealthCheck) {
    const logger = getAsyncContextLogger();
    try {
        logger.info(`Service details for health check :${JSON.stringify(deploymentStatus)}`);
        const healthStatusMap = await checkDeploymentStatus(deploymentStatus, isOptimisticHealthCheck);
        logger.info(`Consolidated health status ${JSON.stringify(healthStatusMap)}`);

        for (const service of deploymentStatus) {
            try {
                const dbDeploymentStatuses = service.db.map(dbStatus => dbStatus.status);
                let consolidatedStatus = 'Unknown';
                const componentTypes = [];

                if (service.db.length > 0) {
                    componentTypes.push('DB');
                    if (dbDeploymentStatuses.includes('Failed')) {
                        consolidatedStatus = "Failed";
                    } else if (dbDeploymentStatuses.includes('Sucess')) {
                        consolidatedStatus = "Sucess";
                    }
                }

                const appDeploymentStatus = service.app?.deploymentStatus?.status || 'NA';
                const appHealthStatus = healthStatusMap[service.app?.cluster]?.[service.app?.service]?.status || 'NA';

                if (appDeploymentStatus !== 'NA') {
                    componentTypes.push('App');
                }

                if (appDeploymentStatus !== 'NA' && appHealthStatus !== 'STABLE') {
                    consolidatedStatus = 'Failure';
                } else if (consolidatedStatus === 'Unknown' && appHealthStatus === 'STABLE') {
                    consolidatedStatus = "Sucess";
                }

                logger.info(`Deployment status - ${service.product} in ${service.region} , Component Name: ${service.service}, Components: ${JSON.stringify(componentTypes)} ,Deployment Status: ${consolidatedStatus}, Application Deployment - Status: ${appDeploymentStatus} Health status: ${appHealthStatus} ,  DB Deployment Status :${JSON.stringify(dbDeploymentStatuses)}`);

            } catch (err) {
                logger.error(`${err.message}`, err.stack);
            }

            if (service.app) {
                if (service.app.deploymentStatus?.status === 'Sucess') {
                    if (healthStatusMap[service.app.cluster]) {
                        service.app.healthStatus = healthStatusMap[service.app.cluster][service.app.service];

                        if (service.app.healthStatus.status !== 'STABLE') {
                            service.app.deploymentStatus.status = `Health Check Failed - ${service.app.healthStatus.status} ,Reason-${service.app.healthStatus.rollbackReason}`;
                        } else {
                            service.app.deploymentStatus.status = `Deployment - ${service.app.deploymentStatus.status}, Health Status - ${service.app.healthStatus.status}`;
                        }
                    } else {
                        getAsyncContextLogger().warn(`Deployment successful but health status map for cluster ${service.app.cluster} is undefined.`);
                    }
                }
            }

        }
    } catch (err) {
        logger.error(`${err.message}`, err.stack);
    }


    return deploymentStatus;
}

function getSortedCatelogData(yamlData) {
    const catalogInfo = yaml.load(yamlData);
    const dataToSort = catalogInfo.data || catalogInfo;
    dataToSort.sort((a, b) => a.executionOrder - b.executionOrder);
    return catalogInfo;
}

function initializeDeploymentStatus(catalogData) {
    return {
        service: catalogData.serviceName, region: catalogData.region.toUpperCase(),
        product: catalogData.product.toUpperCase(),
        app: { cluster: '', service: '', deploymentStatus: {}, healthStatus: {} }, db: []
    };
}

async function handleDatabaseDeployment(catalogData, customerName, tenantName, deploymentStatus) {
    const logger = getAsyncContextLogger();
    if (catalogData.dacpac != undefined && catalogData.dacpac.file) {
        logger.info(`Dacpac found :${catalogData.dacpac.file}`);
        const deploymentStatusDB = await deployToDB(catalogData, customerName, tenantName);
        logger.info(`DB deployment status :${JSON.stringify(deploymentStatusDB)}`);
        deploymentStatus.db = deploymentStatusDB;
    } else {
        logger.info(`Dacpac not found, skipping db deployment :`);
        deploymentStatus.db = [{ message: 'Skipped DB component not found', status: 'NA', file: 'NA', db: 'NA' }];
    }
}

function isDatabaseDeploymentSuccessful(deploymentStatus) {
    if (!deploymentStatus.db || deploymentStatus.db.length === 0) {
        return true; // No DB deployment, so consider it successful
    }
    return !deploymentStatus.db.some(dbStatus => dbStatus.status === 'Failed');
}

async function handleApplicationDeployment(catalogData, configData, clusterConfigData, deploymentStatus,
    customerName, tenantName) {
    const logger = getAsyncContextLogger();
    if (!isDatabaseDeploymentSuccessful(deploymentStatus)) {
        logger.info(`Skipping app deployment due to failed DB deployment`);
        deploymentStatus.app.deploymentStatus.updatedState = 'Skipped for Failed DB deployment ';
        deploymentStatus.app.deploymentStatus.status = 'NA';
        return;
    }

    if (!catalogData.image) {
        logger.info(`Image not found, skipping app deployment`);
        deploymentStatus.app.deploymentStatus.updatedState = 'Skipped image not found ';
        deploymentStatus.app.deploymentStatus.status = 'NA';
        return;
    }

    try {
        const serviceMetaData = await readConfigData(catalogData);

        if (!catalogData.cluster) {
            //deploymentStatus.app.deploymentStatus = { updatedState: 'NA', status: `Failed- Cluster Name not found` };
            //return;
        }

        await generateEnvFiles(serviceMetaData.commonSpec, serviceMetaData.regionSpec, catalogData, customerName, tenantName);
        const cloudFormationTemplate = await generateCloudFormation(serviceMetaData, configData, clusterConfigData);

        logger.info(`cloudFormationTemplate : ${JSON.stringify(cloudFormationTemplate)}`);
        const resourceList = getResourcesFromTemplate(cloudFormationTemplate);
        catalogData.cluster = cloudFormationTemplate.Resources.ECSService.Properties.Cluster; // Update catalogData.cluster

        const resourceIdentifier = {
            serviceType: 'ECSService', resource: resourceList.ECSService,
            serviceName: catalogData.serviceName, region: catalogData.region,
            clusterName: catalogData.cluster
        };

        let stackInfo = await findStackByResource(resourceIdentifier);
        logger.info(`Stack info : ${JSON.stringify(stackInfo)}`);
        let stackName = SERVICE_STACK_PREFIX + catalogData.serviceName + '-' + catalogData.region.toLowerCase() + '-' + catalogData.cluster;

        if (stackInfo) {
            stackName = stackInfo.stackName;
            logger.info(`Stack to be updated:${stackName}`);
            stackInfo = null; // Clear stackInfo for update scenario
        } else {
            logger.info(`Stack to be created:${stackName}`);
        }

        const ecsService = await describeEcsService(resourceIdentifier.clusterName, `${resourceIdentifier.serviceName}-${resourceIdentifier.region.toLowerCase()}`);
        logger.info(`Service desc :${JSON.stringify(ecsService)}`);
        deploymentStatus.app.cluster = resourceIdentifier.clusterName;
        deploymentStatus.app.service = `${resourceIdentifier.serviceName}-${resourceIdentifier.region.toLowerCase()}`;

        if (ecsService != null && ecsService?.status !== 'INACTIVE') {
            logger.info(`Service already available, going to update !!`);
            const initialDeployments = ecsService.deployments || [];
            const initialPrimaryDeployment = initialDeployments.find(d => d.status === "PRIMARY");
            deploymentStatus.app.initialDeploymentId = initialPrimaryDeployment?.id;
            deploymentStatus.app.isUpdate = true;

            const updateStatus = await updateECSTaskAndService(ecsService, resourceIdentifier, cloudFormationTemplate);
            logger.info(`Status from update :${JSON.stringify(updateStatus)}`);
            deploymentStatus.app.deploymentStatus = updateStatus;
        } else {
            logger.info(`Active service not found, going for create !!`);
            deploymentStatus.app.isUpdate = false;
            if (isCreateEnabled(configData, serviceMetaData)) {
                try {
                    const createStatus = await createOrUpdateStack(stackName, stackInfo, cloudFormationTemplate, catalogData.region, catalogData.product, clusterConfigData);
                    logger.info(`Create status :${JSON.stringify(createStatus)}`);
                    deploymentStatus.app.deploymentStatus = { updatedState: 'Service Created', status: `Service Created` };
                } catch (err) {
                    logger.error(`Error creating CFT: ${err.message}`, err.stack);
                    deploymentStatus.app.deploymentStatus = { updatedState: 'Failed', status: `Service Creation Failed ${err.message}` };
                }
            } else {
                deploymentStatus.app.deploymentStatus = { updatedState: 'NA', status: `Failed- Service Creation Not Enabled` };
            }
        }
    } catch (err) {
        logger.error(`Error in ecs update: ${err.message} ${err.stack}`);
        let errReason = err.message;
        if (err.name === 'YAMLException') {
            errReason = "Invalid YAML configuration";
        } else if (err.name === 'NoSuchKey') {
            errReason = "Mandatory Config Files missing";
        }

        deploymentStatus.app.deploymentStatus = { status: `Failed - ${errReason}`, updatedState: errReason };
    }

}

function getResourcesFromTemplate(templateBody) {
    const resourceList = { 'ECSService': templateBody.Resources.ECSService.Properties.ServiceName };
    return resourceList;
}

async function deployService(catalogData, customerName, tenantName) {
    const logger = getAsyncContextLogger();

    const DEPLOYMENT_METADATA_PARAM = `/${customerName}/${tenantName}/framework/CD/DEPLOYMENT/METADATA`;
    const CLUSTER_METADATA_PARAM = `/${customerName}/${tenantName}/framework/CD/CLUSTER/METADATA`;

    const configData = await getSsmParameter(DEPLOYMENT_METADATA_PARAM);
    const clusterConfigData = await getSsmParameter(CLUSTER_METADATA_PARAM);

    logger.info(`Config data: ${JSON.stringify(configData)}`);
    logger.info(`Cluster config data: ${JSON.stringify(clusterConfigData)}`);

    logger.info(`catalog for service : ${JSON.stringify(catalogData)} for ${customerName}, ${tenantName}`);

    const deploymentStatus = initializeDeploymentStatus(catalogData);

    await handleDatabaseDeployment(catalogData, customerName, tenantName, deploymentStatus);
    await handleApplicationDeployment(catalogData, configData, clusterConfigData, deploymentStatus, customerName, tenantName);
    return deploymentStatus;
}

function isCreateEnabled(configData, serviceMetaData) {
    const logger = getAsyncContextLogger();
    let createEnabled = configData.cluster?.doCreateService || false;

    try {
        const productClusterConfig = configData[serviceMetaData.catalogData.product];
        if (productClusterConfig?.config) {
            createEnabled = productClusterConfig.config.cluster?.doCreateService ?? createEnabled;

            const productRegionClusterConfig = productClusterConfig.config[serviceMetaData.catalogData.region];
            createEnabled = productRegionClusterConfig?.doCreateService ?? createEnabled;
        }
    } catch (err) {
        logger.error(`Error in isCreateEnabled: ${err.message}`, err.stack);
    }
    logger.info(`Create enabled : ${createEnabled}`);
    return createEnabled;
}

async function readConfigData(catalogData) {
    const logger = getAsyncContextLogger();
    logger.info(`Reading configuration data for catalog: ${JSON.stringify(catalogData)}`);

    const { serviceName, image, configbucket, product, releaseIdentifier, region } = catalogData;

    if (!serviceName || !image || !configbucket) {
        logger.warn(`Cluster deployment not required due to missing serviceName, image, or configbucket.`);
        // Depending on requirements, might throw an error here or return null
        return null;
    }

    const basePath = `variables/${product}/${serviceName}`;

    const regionSpecFile = `${basePath}/${releaseIdentifier}/app.${region.toLowerCase()}.yml`;
    const regionInfraSpecFile = `${basePath}/${releaseIdentifier}/infra.${region.toLowerCase()}.yml`;
    const commonSpecFile = `${basePath}/${releaseIdentifier}/app.common.yml`;
    const commonInfraSpecFile = `${basePath}/${releaseIdentifier}/infra.common.yml`;

    const commonSpec = await readYamlFromS3(configbucket, commonSpecFile);
    const commonInfraSpec = await readYamlFromS3(configbucket, commonInfraSpecFile);

    let regionSpec = {};
    try {
        regionSpec = await readYamlFromS3(configbucket, regionSpecFile);
    } catch (err) {
        logger.warn(`Unable to find region specific app spec file '${regionSpecFile}'. Falling back to common app spec. Error: ${err.message}`);
        regionSpec = commonSpec;
    }
    let regionInfraSpec = {};
    try {
        regionInfraSpec = await readYamlFromS3(configbucket, regionInfraSpecFile);
    } catch (err) {
        logger.warn(`Unable to find region specific infra spec file '${regionInfraSpecFile}'. Falling back to common infra spec. Error: ${err.message}`);
        regionInfraSpec = commonInfraSpec;
    }


    const serviceMetaData = { commonSpec, regionSpec, catalogData, commonInfraSpec, regionInfraSpec };
    return serviceMetaData;
}
