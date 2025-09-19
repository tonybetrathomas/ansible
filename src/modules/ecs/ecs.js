import { DescribeServicesCommand, UpdateServiceCommand, DescribeTasksCommand, DescribeTaskDefinitionCommand, ListTasksCommand,DeleteServiceCommand, RegisterTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import deepDiff from 'deep-diff';
import { compareObjects } from '../utils/CompareUtils.js';
import { updateHealthCheckPath } from '../loadbalancer/TargetGroupHandler.js';
import { getAsyncContextLogger } from '../../utils/logger.js';
import { ecsClient } from '../../utils/awsClients.js';

const region = process.env.AWS_REGION || "us-east-1";

const PRIMARY_DEPLOYMENT_STATUS = "PRIMARY";
const INACTIVE_SERVICE_STATUS = 'INACTIVE';
const STABLE_HEALTH_STATUS = 'STABLE';
const RUNNING_TASK_STATUS = "RUNNING";
const HEALTHY_CONTAINER_STATUS = "HEALTHY";
const DEFAULT_TIMEOUT_MINUTES = 15;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;

// Constants for common log/error messages
const SERVICE_NOT_FOUND_ERROR_MESSAGE = 'Service not found.';
const TASK_DEF_UPDATE_ERROR_MESSAGE = 'Error while updating TD:';
const HEALTH_URL_INVALID_ERROR_MESSAGE = 'Health url provided is invalid';
const UNABLE_TO_CHECK_HEALTH_STATUS_MESSAGE = 'Unable to check health status for :';
const ERROR_CHECKING_SERVICE_MESSAGE = 'Error checking service';
const SERVICE_HEALTH_UNKNOWN_TIMEOUT_MESSAGE = 'Service Health Status Unknown after timeout';
const SERVICE_NOT_FOUND_IN_CLUSTER_MESSAGE = 'Service not found in cluster';

export async function describeEcsService(clusterName, serviceName) {
  const logger = getAsyncContextLogger();
  logger.info(`Cluster: ${clusterName} Service: ${serviceName}`);
  try {
    const params = {
      cluster: clusterName,
      services: [serviceName]
    };
    const command = new DescribeServicesCommand(params);
    const result = await ecsClient.send(command);
    return result.services && result.services.length > 0 ? result.services[0] : null;
  } catch (error) {
    logger.error(`Error describing ECS service: ${error.message}`, error.stack);
    throw error;
  }
}

export async function deleteEcsService(clusterName, serviceName) {
  const logger = getAsyncContextLogger();
  logger.info(`Cluster: ${clusterName} Service: ${serviceName}`);
  try {
    const params = {
      cluster: clusterName,
      service: serviceName
    };
    const command = new DeleteServiceCommand(params);
    const result = await ecsClient.send(command);
    return result;
  } catch (error) {
    logger.error(`Error deleting ECS service: ${error.message}`, error.stack);
    throw error;
  }
}

export async function updateService(serviceDetails) {
  const logger = getAsyncContextLogger();
  try {

    const command = new UpdateServiceCommand(serviceDetails);
    const data = await ecsClient.send(command);
    logger.info(`Service updated: ${data.service.serviceName}`);
    return data;
  } catch (error) {
    logger.error(`Error updating service: ${error.message}`, error.stack);
    throw error;
  }
}


async function getTaskDefinition(taskDefinitionArn) {
  const logger = getAsyncContextLogger();
  try {
    const params = {
      taskDefinition: taskDefinitionArn
    };
    const command = new DescribeTaskDefinitionCommand(params);
    const data = await ecsClient.send(command);
    return data.taskDefinition;
  } catch (error) {
    logger.error(`Error getting task definition: ${error.message}`, error.stack);
    throw error; // Throw the error to be handled by the caller
  }
}

async function updateTaskDefinition(taskDefinition) {
  const logger = getAsyncContextLogger();
  try {
    // Modify the task definition as needed
    const command = new RegisterTaskDefinitionCommand(taskDefinition);
    const data = await ecsClient.send(command);
    // logger.info('Task definition updated:', data.taskDefinition);
    return data.taskDefinition;
  } catch (error) {
    logger.error(`Error updating task definition: ${error.message}`, error.stack);
    throw error; // Throw the error to be handled by the caller
  }
}


function extractTaskDefinitionProperties(cloudFormationTemplate) {
    const containerDef = cloudFormationTemplate.Resources.TaskDefinition.Properties.ContainerDefinitions[0];
    return {
        memoryReservation: containerDef.MemoryReservation,
        memory: containerDef.Memory,
        image: containerDef.Image,
        containerHealthCheckCommand: containerDef.HealthCheck?.Command,
        tgHealthCheckPath: cloudFormationTemplate.Resources.ALBTargetGroup.Properties.HealthCheckPath,
        requestedPort: cloudFormationTemplate.Resources.ALBTargetGroup.Properties.Port,
        envFilesCFT: containerDef.EnvironmentFiles,
        secretsCFT: containerDef.Secrets,
        mountPoints: containerDef.MountPoints,
        volumes:  cloudFormationTemplate.Resources.TaskDefinition.Properties.Volumes,
    };
}

function applyTaskDefinitionUpdates(taskDefinition, extractedProperties, cloudFormationTemplate) {
    taskDefinition.containerDefinitions[0].memoryReservation = extractedProperties.memoryReservation;
    taskDefinition.containerDefinitions[0].memory = extractedProperties.memory;
    taskDefinition.containerDefinitions[0].image = extractedProperties.image;

    const scConfigFromIp = cloudFormationTemplate.Resources.ECSService.Properties.ServiceConnectConfiguration;
    if (scConfigFromIp && !taskDefinition.networkMode) {
        getAsyncContextLogger().info('service connect config found with no network defined ');
        taskDefinition.networkMode = 'bridge';
        if (!taskDefinition.containerDefinitions[0].portMappings[0].name) {
            taskDefinition.containerDefinitions[0].portMappings[0].name = scConfigFromIp.Services[0].PortName;
        }
    }

    const mountsPoints =[]
    const volumes =[]
    if(extractedProperties.mountPoints){
      for (const mountPoint of extractedProperties.mountPoints) {
        const containerPath = mountPoint.ContainerPath;
        if(containerPath){
          mountsPoints.push({'sourceVolume': mountPoint.SourceVolume ,'containerPath': containerPath});
        }
      }

      for (const volume of extractedProperties.volumes) {
        volumes.push({'name': volume.Name ,'host': {'sourcePath': volume.Host.SourcePath}});
      }
  }
    
    if(mountsPoints.length>0 && volumes.length>0){
      taskDefinition.containerDefinitions[0].mountPoints =mountsPoints;
      taskDefinition.volumes = volumes;
    }

}

async function handleHealthCheckUpdate(taskDefinition, extractedProperties, ecsService) {
    const logger = getAsyncContextLogger();
    const containerHealthCheckUrl = extractedProperties.containerHealthCheckCommand?.[1];
    const tgHealthCheckUrl = extractedProperties.tgHealthCheckPath;
    const requestedPort = extractedProperties.requestedPort;

    logger.info(`Container healthcheck url from ip : ${containerHealthCheckUrl}`);
    logger.info(`Tg healthcheck url from ip : ${tgHealthCheckUrl}`);

    const healthPathContainer = taskDefinition.containerDefinitions[0].healthCheck?.command?.[1];
    const runningPort = taskDefinition.containerDefinitions[0].portMappings?.[0]?.containerPort;

    logger.info(`Current container healthcheck url : ${healthPathContainer}`);
    if (healthPathContainer !== containerHealthCheckUrl) {
        logger.info(`Change in health check path`);
        if (containerHealthCheckUrl && !containerHealthCheckUrl.includes('undefined') && !containerHealthCheckUrl.includes('null')) {
            logger.info(`Valid health check path`);
            if (runningPort === requestedPort) {
                logger.warn(`Updating health check path`);
                taskDefinition.containerDefinitions[0].healthCheck.command = extractedProperties.containerHealthCheckCommand;
                const loadBalancer = ecsService.loadBalancers?.[0];
                if (loadBalancer?.targetGroupArn) {
                    await updateHealthCheckPath(loadBalancer.targetGroupArn, tgHealthCheckUrl);
                }
            } else {
                logger.warn(`Port change requested :`);
            }
        } else {
            logger.error(HEALTH_URL_INVALID_ERROR_MESSAGE);
        }
    }
}

function handleEnvironmentFiles(taskDefinition, extractedProperties) {
    const logger = getAsyncContextLogger();
    const environmentFiles = extractedProperties.envFilesCFT.map(envFile => ({ type: envFile.Type, value: envFile.Value }));
    taskDefinition.containerDefinitions[0].environmentFiles = environmentFiles;
}

function handleSecrets(taskDefinition, extractedProperties) {
    const logger = getAsyncContextLogger();
    const secrets = extractedProperties.secretsCFT.map(referance => ({ name: referance.Name, valueFrom: referance.ValueFrom }));
    taskDefinition.containerDefinitions[0].environment = []; // Clear existing environment variables
    logger.info(`Secrets for task def : ${JSON.stringify(secrets)} `);
    taskDefinition.containerDefinitions[0].secrets = secrets;
}

async function updateTaskDefinitionIfNeeded(originalTaskDefinition, newTaskDefinition) {
    const logger = getAsyncContextLogger();
    const differences = await compareObjects(originalTaskDefinition, newTaskDefinition, `TD`);
    logger.info(`Diff :${JSON.stringify(differences)}`);

    if (differences.length > 0) {
        try {
            const updatedTaskDef = await updateTaskDefinition(newTaskDefinition);
            logger.info(`TD updated : ${JSON.stringify(updatedTaskDef)}`);
            return updatedTaskDef.taskDefinitionArn;
        } catch (err) {
            logger.error(`${TASK_DEF_UPDATE_ERROR_MESSAGE} ${JSON.stringify(newTaskDefinition)}`, err);
            throw err;
        }
    } else {
        logger.info(`No change in TD , skipping TD update ..`);
        return originalTaskDefinition.taskDefinitionArn;
    }
}

function prepareServiceUpdate(resourceIdentifier, serviceName, taskDefArn, ecsService, cloudFormationTemplate) {
    const logger = getAsyncContextLogger();
    let desiredCount = cloudFormationTemplate.Resources.ECSService.Properties.DesiredCount;
    if (desiredCount === undefined) {
        logger.warn(`Instance count undefined in template, not updating count`);
        desiredCount = ecsService.desiredCount;
    }
    logger.info(`Setting instance count ${desiredCount}`);

    return {
        cluster: resourceIdentifier.clusterName,
        service: serviceName,
        desiredCount: desiredCount,
        taskDefinition: taskDefArn,
        deploymentConfiguration: ecsService.deploymentConfiguration,
        networkConfiguration: ecsService.networkConfiguration,
        healthCheckGracePeriodSeconds: ecsService.healthCheckGracePeriodSeconds,
        loadBalancers: ecsService.loadBalancers,
        serviceRegistries: ecsService.serviceRegistries,
        deploymentController: ecsService.deploymentController,
        placementStrategy: ecsService.placementStrategy,
        schedulingStrategy: ecsService.schedulingStrategy,
        placementConstraints: ecsService.placementConstraints,
        forceNewDeployment: true // Force a new deployment
    };
}

function handleServiceConnectConfiguration(ecsServiceUpdated, cloudFormationTemplate, ecsService) {
    const logger = getAsyncContextLogger();
    const scConfigFromIp = cloudFormationTemplate.Resources.ECSService.Properties.ServiceConnectConfiguration;
    const primaryDeployment = ecsService.deployments?.find((d) => d.status === PRIMARY_DEPLOYMENT_STATUS);
    const scConfig = primaryDeployment?.serviceConnectConfiguration;

    logger.info(`Service connect from service : ${JSON.stringify(scConfig)}`);
    logger.info(`Service connect ip :${JSON.stringify(scConfigFromIp)}`);

    if (scConfigFromIp && (!scConfig || !scConfig.enabled)) {
        logger.info('Enabling service connect');
        const serviceConnectConfig = {
            enabled: true,
            namespace: scConfigFromIp.Namespace,
            services: []
        };

        for (const service of scConfigFromIp.Services) {
            const scService = { portName: service.PortName, discoveryName: service.DiscoveryName, clientAliases: [] };
            for (const alias of service.ClientAliases) {
                scService.clientAliases.push({ port: alias.Port, dnsName: alias.DnsName });
            }
            serviceConnectConfig.services.push(scService);
        }
        logger.info(`${JSON.stringify(serviceConnectConfig)}`);
        ecsServiceUpdated.serviceConnectConfiguration = serviceConnectConfig;
    }
}

export async function updateECSTaskAndService(ecsService, resourceIdentifier, cloudFormationTemplate) {
    const logger = getAsyncContextLogger();
    let deploymentStatus = {};
    try {
        const serviceName = `${resourceIdentifier.serviceName}-${resourceIdentifier.region.toLowerCase()}`;

        let taskDefinition = await getTaskDefinition(ecsService.taskDefinition);
        const taskDefinitionOriginal = JSON.parse(JSON.stringify(taskDefinition));

        const extractedProperties = extractTaskDefinitionProperties(cloudFormationTemplate);

        applyTaskDefinitionUpdates(taskDefinition, extractedProperties, cloudFormationTemplate);
        await handleHealthCheckUpdate(taskDefinition, extractedProperties, ecsService);
        handleEnvironmentFiles(taskDefinition, extractedProperties);
        handleSecrets(taskDefinition, extractedProperties);

        const taskDefArn = await updateTaskDefinitionIfNeeded(taskDefinitionOriginal, taskDefinition);

        const ecsServiceUpdated = prepareServiceUpdate(resourceIdentifier, serviceName, taskDefArn, ecsService, cloudFormationTemplate);
        handleServiceConnectConfiguration(ecsServiceUpdated, cloudFormationTemplate, ecsService);

        const status = await updateService(ecsServiceUpdated);
        deploymentStatus.updatedState = status;
        deploymentStatus.status = 'Sucess';
        return deploymentStatus;
    } catch (err) {
        logger.error(`Exception in ecs update :${err.message}`, err.stack);
        deploymentStatus.updatedState = err.message;
        deploymentStatus.status = `Failed -${err.message}`;
        return deploymentStatus;
    }
}

export async function updateServiceInstance(ecsService ,clusterName,serviceName, instanceCount) {
  const logger = getAsyncContextLogger();
  let deploymentStatus = {};
  try {

    let taskDefinition = await getTaskDefinition(ecsService.taskDefinition);
    
    let ecsServiceUpdated = {
      cluster: clusterName,
      service: serviceName,
      desiredCount: instanceCount,
      taskDefinition: taskDefinition.taskDefinitionArn,
      deploymentConfiguration: ecsService.deploymentConfiguration,
      networkConfiguration: ecsService.networkConfiguration,
      healthCheckGracePeriodSeconds: ecsService.healthCheckGracePeriodSeconds,
      loadBalancers: ecsService.loadBalancers,
      serviceRegistries: ecsService.serviceRegistries,
      healthCheckGracePeriodSeconds: ecsService.healthCheckGracePeriodSeconds,
      deploymentController: ecsService.deploymentController,
      placementStrategy: ecsService.placementStrategy,
      schedulingStrategy: ecsService.schedulingStrategy,
      placementConstraints: ecsService.placementConstraints,
      forceNewDeployment: true // Force a new deployment
    };


    const status = await updateService(ecsServiceUpdated);
    // logger.info(`status: ${JSON.stringify(status)}`);
    deploymentStatus.updatedState = status;
    deploymentStatus.status = 'Sucess';
    return deploymentStatus;
  } catch (err) {

    logger.error(`Exception in ecs update :${err.message}`, err.stack);
    deploymentStatus.updatedState = err.message;
    deploymentStatus.status = `Failed -${err.message}`;
    return deploymentStatus;
  }
}


export async function checkServiceStatus(clusterName, serviceName) {
  const logger = getAsyncContextLogger();

  const service = await describeEcsService(clusterName, serviceName);
  let statusData = {};
  if (service) {

    statusData.status = service.status;
    statusData.runningCount = service.runningCount;
    statusData.desiredCount = service.desiredCount;
    statusData.pendingCount = service.pendingCount;
    statusData.healthStatus = service.healthStatus;
    statusData.deployment = service.deployments[0];

  } else {
    logger.info(SERVICE_NOT_FOUND_ERROR_MESSAGE);
  }

  return statusData;

}

async function getServiceDetails(clusterName, serviceName) {
  const logger = getAsyncContextLogger();
  const command = new DescribeServicesCommand({
    cluster: clusterName,
    services: [serviceName]
  });

  const response = await ecsClient.send(command);

  if (response.services.length === 0) {
    logger.error(`${SERVICE_NOT_FOUND_IN_CLUSTER_MESSAGE} ${serviceName} in cluster ${clusterName}`);
    throw new Error(`${SERVICE_NOT_FOUND_IN_CLUSTER_MESSAGE} ${serviceName} in cluster ${clusterName}`);
  }

  return response.services[0];
}

function initializeResultsObject() {
    return {};
}

async function monitorServiceDeployment(clusterName, serviceName, initialDeploymentId, { timeoutMinutes, pollIntervalSeconds }) {
    const logger = getAsyncContextLogger();
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const pollIntervalMs = pollIntervalSeconds * 1000;
    const startTime = Date.now();

    let isStable = false;
    let activeDeployment = null;
    let rollbackOccurred = false;
    let rollbackReason = "Unknown";
    const deploymentHistory = {};

    logger.info(`Monitoring deployment status for ${serviceName}...`);

    while (!isStable && (Date.now() - startTime < timeoutMs)) {
        let serviceDetails;
        try {
            serviceDetails = await getServiceDetails(clusterName, serviceName);
        } catch (error) {
            logger.warn(`Could not get service details for ${serviceName}: ${error.message}. Retrying...`);
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            continue;
        }

        activeDeployment = serviceDetails.deployments.find(d => d.status === PRIMARY_DEPLOYMENT_STATUS);

        if (!activeDeployment) {
            logger.info(`No active deployment found for ${serviceName}`);
            break;
        }

        serviceDetails.deployments.forEach(d => {
            if (deploymentHistory[d.id]) {
                deploymentHistory[d.id].lastSeen = Date.now();
                deploymentHistory[d.id].status = d.status;
            } else {
                deploymentHistory[d.id] = {
                    firstSeen: Date.now(),
                    lastSeen: Date.now(),
                    status: d.status,
                    taskDefinition: d.taskDefinition
                };
            }
        });

        if (initialDeploymentId !== activeDeployment.id) {
            const initialDeploymentInfo = deploymentHistory[initialDeploymentId];
            if (initialDeploymentInfo) {
                const relevantEvents = serviceDetails.events
                    .filter(e => e.createdAt >= new Date(initialDeploymentInfo.firstSeen - 60000))
                    .filter(e => e.message.includes("failed") || e.message.includes("roll"));
                if (relevantEvents.length > 0) {
                    rollbackOccurred = true;
                    rollbackReason = relevantEvents[0].message;
                }
            } else {
                const deploymentIdTimestamp = extractTimestampFromDeploymentId(initialDeploymentId);
                const activeDeploymentTimestamp = extractTimestampFromDeploymentId(activeDeployment.id);
                if (deploymentIdTimestamp && activeDeploymentTimestamp && activeDeploymentTimestamp > deploymentIdTimestamp) {
                    const relevantEvents = serviceDetails.events
                        .filter(e => e.message.includes("failed") || e.message.includes("roll"));
                    if (relevantEvents.length > 0) {
                        rollbackOccurred = true;
                        rollbackReason = relevantEvents[0].message;
                    }
                }
            }
        }

        const deploymentComplete = activeDeployment.runningCount === activeDeployment.desiredCount &&
            activeDeployment.pendingCount === 0 &&
            serviceDetails.deployments.length === 1;

        const healthCheckPassed = await checkHealthStatus(clusterName, serviceName, activeDeployment);
        isStable = deploymentComplete && healthCheckPassed;

        if (isStable) {
            logger.info(`Deployment of ${serviceName} has stabilized`);
            break;
        }

        if (rollbackOccurred) {
            logger.info(`Detected rollback for ${serviceName} - initial ID: ${initialDeploymentId}, current ID: ${activeDeployment.id}`);
            logger.info(`Rollback reason: ${rollbackReason}`);
        }

        logger.info(`Waiting for ${pollIntervalSeconds}s before checking ${serviceName} again...`);
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    const isTimeOut = !isStable && (Date.now() - startTime >= timeoutMs);

    let finalServiceDetails = null;
    try {
        finalServiceDetails = await getServiceDetails(clusterName, serviceName);
    } catch (error) {
        logger.warn(`Could not get final service details for ${serviceName}: ${error.message}`);
    }

    return {
        isStable,
        isTimeOut,
        activeDeployment,
        rollbackOccurred,
        rollbackReason,
        finalServiceDetails,
        startTime
    };
}

function generateDeploymentResult(clusterName, serviceName, initialDeploymentId, activeDeployment, isStable, isTimeOut, rollbackOccurred, rollbackReason, serviceDetails, startTime) {
   const logger = getAsyncContextLogger();
    const events = serviceDetails?.events
        .filter(event => event.message.includes("failed") || event.message.includes("roll") || event.message.includes("health"))
        .slice(0, 10) || [];

    return {
        clusterName,
        serviceName,
        initialDeploymentId,
        currentDeploymentId: activeDeployment?.id || 'unknown',
        status: isStable ? STABLE_HEALTH_STATUS : isTimeOut ? SERVICE_HEALTH_UNKNOWN_TIMEOUT_MESSAGE : (activeDeployment?.status || "UNKNOWN"),
        rollbackOccurred,
        rollbackReason: rollbackOccurred ? rollbackReason : null,
        desiredCount: activeDeployment?.desiredCount || 0,
        pendingCount: activeDeployment?.pendingCount || 0,
        runningCount: activeDeployment?.runningCount || 0,
        failedTasks: activeDeployment?.failedTasks || 0,
        events: events.map(e => `${new Date(e.createdAt).toISOString()} - ${e.message}`).join('\n'),
        taskDefinitionArn: activeDeployment?.taskDefinition || null,
        createdAt: activeDeployment?.createdAt || null,
        updatedAt: activeDeployment?.updatedAt || null,
        isStable,
        monitoringTimeElapsed: `${((Date.now() - startTime) / 1000 / 60).toFixed(2)} minutes`
    };
}

export async function checkDeploymentStatus(services, isOptimisticHealthCheck, options = {}) {
  const logger = getAsyncContextLogger();
  try {
    logger.info(`Service details for health check :${JSON.stringify(services)}`);
    const { timeoutMinutes = DEFAULT_TIMEOUT_MINUTES, pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS } = options;

    const results = initializeResultsObject();

    for (const service of services) {
      if (service.app?.isUpdate === true && service.app.deploymentStatus?.status === 'Sucess' && service.app.initialDeploymentId) {
        const clusterName = service.app.cluster;
        const serviceName = service.app.service;
        const initialDeploymentId = service.app.initialDeploymentId;

        logger.info(`Checking deployment status for ${serviceName} in cluster ${clusterName}...`);

        try {
          const monitoringResult = await monitorServiceDeployment(clusterName, serviceName, initialDeploymentId, { timeoutMinutes, pollIntervalSeconds });

          results[clusterName] = results[clusterName] || {};
          results[clusterName][serviceName] = generateDeploymentResult(
            clusterName,
            serviceName,
            initialDeploymentId,
            monitoringResult.activeDeployment,
            monitoringResult.isStable,
            monitoringResult.isTimeOut,
            monitoringResult.rollbackOccurred,
            monitoringResult.rollbackReason,
            monitoringResult.finalServiceDetails,
            monitoringResult.startTime
          );

        } catch (error) {
          logger.error(`Error checking service ${serviceName}: ${error.message}`, error.stack);
          results[clusterName] = results[clusterName] || {};
          results[clusterName][serviceName] = {
            clusterName,
            serviceName,
            status: "ERROR",
            message: error.message,
            rollbackOccurred: false,
            isStable: false
          };
        }
      } else {
        logger.info(`${UNABLE_TO_CHECK_HEALTH_STATUS_MESSAGE} ${JSON.stringify(service)}`);
      }
    }

    return results;
  } catch (err) {
    logger.error(`${err.message}`, err.stack);
    return {};
  }
}

async function checkHealthStatus(clusterName, serviceName, deployment) {
    const logger = getAsyncContextLogger();
    try {
        const listTasksCommand = new ListTasksCommand({
            cluster: clusterName,
            serviceName: serviceName,
            desiredStatus: RUNNING_TASK_STATUS
        });

        const tasksResponse = await ecsClient.send(listTasksCommand);

        if (!tasksResponse.taskArns?.length) {
            logger.info(`No running tasks found for ${serviceName}`);
            return false;
        }

        const describeTasksCommand = new DescribeTasksCommand({
            cluster: clusterName,
            tasks: tasksResponse.taskArns
        });

        const taskDetails = await ecsClient.send(describeTasksCommand);

        const unhealthyTasks = taskDetails.tasks.filter(task => {
            if (task.taskDefinitionArn !== deployment.taskDefinition) {
                return true; // Task is from a different deployment
            }

            const unhealthyContainers = task.containers.filter(container => {
                return container.healthStatus && container.healthStatus !== HEALTHY_CONTAINER_STATUS;
            });

            return unhealthyContainers.length > 0;
        });

        const isHealthy = unhealthyTasks.length === 0 && taskDetails.tasks.length > 0;

        if (!isHealthy) {
            logger.info(`Found ${unhealthyTasks.length} unhealthy tasks for ${serviceName}`);
        } else {
            logger.info(`All ${taskDetails.tasks.length} tasks are healthy for ${serviceName}`);
        }

        return isHealthy;

    } catch (error) {
        logger.error(`Error checking health status for ${serviceName}: ${error.message}`);
        return false;
    }
}


async function getTaskDefinitionDetails(taskDefinitionArn) {
    const logger = getAsyncContextLogger();
    const command = new DescribeTaskDefinitionCommand({
        taskDefinition: taskDefinitionArn
    });

    const response = await ecsClient.send(command);
    return response.taskDefinition;
}

function extractTimestampFromDeploymentId(deploymentId) {
    const logger = getAsyncContextLogger();
    try {
        if (deploymentId?.includes('ecs-svc/')) {
            const parts = deploymentId.split('/');
            if (parts.length > 1) {
                const numberPart = parts[1];
                if (numberPart.length >= 10) {
                    return parseInt(numberPart.substring(0, 10), 10);
                }
            }
        }
        return null;
    } catch (error) {
        logger.warn(`Error extracting timestamp from deployment ID: ${error.message}`);
        return null;
    }
}