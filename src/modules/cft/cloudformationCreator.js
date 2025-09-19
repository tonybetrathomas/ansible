import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from "fs";
import { getClusterVpc } from '../cft/resourceFinder.js';
import { subcriptionInfo } from '../sts/sts.js';
import { config } from 'process';
import { getAsyncContextLogger } from '../../utils/logger.js';


export async function generateCloudFormation(serviceMetaData, configData,clusterConfigData) {
    const logger = getAsyncContextLogger();

    logger.info(`ServiceMetaData: ${JSON.stringify(serviceMetaData)}`);
    logger.info(`SubscriptionInfo: ${JSON.stringify(subcriptionInfo)}`);
    //service
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);

        // Construct the path to the JSON file
        const jsonFilePath = join(__dirname, '../../', 'templates', 'CFTemplate.json');

        const data = fs.readFileSync(jsonFilePath, 'utf8');
        let template = JSON.parse(data);
        //await updateServiceToTemplate(template,serviceMetaData);
        //await updateTaskToTemplate(template,serviceMetaData);
        // logger.info("template :"+JSON.stringify(template));


        if (!serviceMetaData.commonSpec.variables) {
            throw new Error("Mandatory Parameters missing in config files"); // Extracted to constant soon
        }

        // handle non root user
        let runUser = serviceMetaData.commonInfraSpec?.runUser;

        if (!runUser) {
            runUser = serviceMetaData.regionInfraSpec?.runUser;
        }

        if(runUser){
            template.Resources.TaskDefinition.Properties.ContainerDefinitions[0].User = runUser;
        }

    

        let serviceName = serviceMetaData.catalogData.serviceName;

        if (serviceMetaData.commonInfraSpec?.serviceName) {
            logger.warn(`Non-standard service name found setting it ${serviceMetaData.commonInfraSpec.serviceName} instead of  ${serviceName}`);
            serviceName = serviceMetaData.commonInfraSpec.serviceName;
        } else {
            logger.info(`Going with standard service name ${serviceName}`);
        }

        template.Resources.ECSService.Properties.ServiceName = serviceName + "-" + serviceMetaData.catalogData.region.toLowerCase();

        const clusterName = getClusterName(configData, serviceMetaData);

        template.Resources.ECSService.Properties.Cluster = clusterName;
        template.Resources.ECSService.Properties.LoadBalancers[0].ContainerName =  template.Resources.ECSService.Properties.ServiceName;
        template.Resources.ECSService.Properties.DesiredCount = serviceMetaData.regionInfraSpec?.instanceCount ?? serviceMetaData.commonInfraSpec.instanceCount;


        const vpcIds = await getClusterVpc(template.Resources.ECSService.Properties.Cluster);
        template.Resources.ALBTargetGroup.Properties.VpcId = vpcIds[0];

        //TD
        setTaskDef(serviceMetaData, template, configData);

        let serviceConnectConfig = null;
        const region = serviceMetaData.catalogData.region.toUpperCase();
        const product = serviceMetaData.catalogData.product;
        serviceConnectConfig = clusterConfigData[region]?.[product]?.serviceConnect; // Simplified optional chaining

        //${containerDefinition.Name}-${containerDefinition.PortMappings[0].ContainerPort}-tcp`;
        let containerDefinition = template.Resources.TaskDefinition.Properties.ContainerDefinitions[0];

        containerDefinition.PortMappings[0].Name = `${containerDefinition.Name}-${containerDefinition.PortMappings[0].ContainerPort}-tcp`; 
        // service connect 
        const isSCToBeEnabled = serviceMetaData.regionInfraSpec?.enableInterServiceCommunication ?? serviceMetaData.commonInfraSpec?.enableInterServiceCommunication ?? false;
        
        if(serviceConnectConfig?.nameSpace && isSCToBeEnabled ){
                    logger.info(`Enabling interservice communication`);
                    
                    let ServiceConnectConfiguration = template.Resources.ECSService.Properties.ServiceConnectConfiguration;
                    ServiceConnectConfiguration.Services[0].PortName = `${containerDefinition.Name}-${containerDefinition.PortMappings[0].ContainerPort}-tcp`;
                    ServiceConnectConfiguration.Services[0].DiscoveryName = containerDefinition.Name;
                    
                    logger.info(`Client alias : ${JSON.stringify(ServiceConnectConfiguration.Services[0].ClientAliases[0])}`);
                    ServiceConnectConfiguration.Services[0].ClientAliases[0].Port = containerDefinition.PortMappings[0].ContainerPort;
                    ServiceConnectConfiguration.Services[0].ClientAliases[0].DnsName = containerDefinition.Name;
                    ServiceConnectConfiguration.Namespace = serviceConnectConfig.nameSpace;
                    template.Resources.ECSService.Properties.ServiceConnectConfiguration = ServiceConnectConfiguration;
                    template.Resources.TaskDefinition.Properties.NetworkMode = 'bridge';
            }else if (template.Resources.ECSService.Properties.ServiceConnectConfiguration){
                logger.info(`Disabling interservice communication`);
                delete template.Resources.ECSService.Properties.ServiceConnectConfiguration;
            }
        

        return template;
    } catch (err) {
        logger.error(`Error in ecs service cft update : ${err.message} - ${err.stack}  : ${JSON.stringify(serviceMetaData)}`);
        throw err;
    }
}
function getALBTGName(serviceMetaData,port) {
    const logger = getAsyncContextLogger();

    const serviceName = serviceMetaData.catalogData.serviceName;
    const serviceShortHand  = getShortName(serviceName);
    logger.info(`Service short hand: ${serviceShortHand}`);
    let albTgName =`tgp-ecs-${serviceMetaData.catalogData.product}-${serviceMetaData.catalogData.region.toLowerCase()}-${port}`;
    logger.info(`AlbTgName : ${albTgName}`);
    return albTgName;
}

function getShortName(input){
    const logger = getAsyncContextLogger();
    try{
    const parts = input.split('-'); 
    const word1 =  parts[1] || '';
    
    const trimmedWord1 = word1.length > 4 ? word1.slice(0, 3) : word1;

    return trimmedWord1 ? `-${trimmedWord1}` : '';
   }catch(err){
    logger.error(`${err.message}`, err.stack);
   } 
}

function getClusterName(configData, serviceMetaData) {
    const logger = getAsyncContextLogger();
    logger.info(`In getCluster method`);
    let clusterName = serviceMetaData.regionInfraSpec?.clusterName ?? `${serviceMetaData.commonInfraSpec.clusterName}-${serviceMetaData.catalogData.region.toLowerCase()}`;
    let isUserDefinedClusterName = configData.cluster?.IsUserPriority ?? false;
    let clusterNameFromConfig = '';
    const serviceLine = serviceMetaData.catalogData.serviceLine;
    logger.info(`Service line : ${serviceLine}`);
    try {
        const productClusterConfig = configData[serviceMetaData.catalogData.product];
        if (productClusterConfig) {
            logger.info(`Checking at product level`);

            isUserDefinedClusterName = productClusterConfig.cluster?.IsUserPriority ?? isUserDefinedClusterName;
            logger.info(`ProductClusterConfig ${JSON.stringify(productClusterConfig)}`);

            if (productClusterConfig.config) {

                const productRegionClusterConfig = productClusterConfig.config[serviceMetaData.catalogData.region];

                logger.info(`ProductRegionClusterConfig ${serviceMetaData.catalogData.region}::${JSON.stringify(productRegionClusterConfig)}`);
                if (productRegionClusterConfig) {
                    logger.info(`Checking at product region level`);

                    isUserDefinedClusterName = productRegionClusterConfig.IsUserPriority ?? isUserDefinedClusterName;

                    if (productRegionClusterConfig.cluster) {
                        if (serviceLine && productRegionClusterConfig.cluster[serviceLine]) {
                            clusterNameFromConfig = productRegionClusterConfig.cluster[serviceLine];
                        } else {
                            clusterNameFromConfig = productRegionClusterConfig.cluster.default;
                        }
                    }
                }
            }

        }
        logger.info(`ClusterNameFromConfig :${clusterNameFromConfig} ${isUserDefinedClusterName}`);

        if (!isUserDefinedClusterName && clusterNameFromConfig) {
            clusterName = clusterNameFromConfig;
            logger.info(`Cluster Name from config`);
        }
    } catch (err) {
        logger.error(`${err.message}`, err.stack);
    }
    logger.info(`Cluster name : ${clusterName}`);
    return clusterName;
}

function setTaskDef(serviceMetaData, template, configData) {
    const logger = getAsyncContextLogger();
    let referanceValues = {};
    let referanceSecrets = {};


    for (const variableName in serviceMetaData.commonSpec.variables) {
        if (serviceMetaData.commonSpec.variables.hasOwnProperty(variableName)) {
            const variable = serviceMetaData.commonSpec.variables[variableName];
            if (variable?.reference) {
                if (variable.type == 'secret') {
                    referanceSecrets[variableName] = variable.reference;
                } else {
                    referanceValues[variableName] = variable.reference;
                }
            }else{
                logger.warn(`${variableName} value null`);
            }
        }
    }

    if (serviceMetaData.regionSpec?.variables) {
        for (const variableName in serviceMetaData.regionSpec.variables) {
            if (serviceMetaData.regionSpec.variables.hasOwnProperty(variableName)) {
                const variable = serviceMetaData.regionSpec.variables[variableName];
                if (variable?.reference) {
                    if (variable.type == 'secret') {
                        referanceSecrets[variableName] = variable.reference;
                    } else {
                        referanceValues[variableName] = variable.reference;
                    }
                }else{
                    logger.warn(`${variableName} value null`);
                }
            }
        }
    }

    logger.info(`Paramter ref :${JSON.stringify(referanceValues)}`);
    logger.info(`Secret ref :${JSON.stringify(referanceSecrets)}`);

    let containerDefinition = template.Resources.TaskDefinition.Properties.ContainerDefinitions[0];
    const minMemory = serviceMetaData.regionInfraSpec?.minMemory ?? serviceMetaData.commonInfraSpec?.minMemory ?? 512;
    let maxMemory = serviceMetaData.regionInfraSpec?.maxMemory ?? serviceMetaData.commonInfraSpec?.maxMemory ?? minMemory;

    if (maxMemory < minMemory) {
        maxMemory = minMemory;
        logger.info(`Max memory less than min setting to min value ${maxMemory}`);
    }
    var { applicationPort, healthCheckUri, healthApi,contextPath } = getPortAndHealthUri(serviceMetaData);
    
    template.Resources.ALBListener.Properties.Port = applicationPort;
       
    template.Resources.ALBTargetGroup.Properties.HealthCheckPath = `/${contextPath}/${healthApi}`;
    template.Resources.ALBTargetGroup.Properties.Port = applicationPort;
    const albTgName = getALBTGName(serviceMetaData,applicationPort);
    template.Resources.ALBTargetGroup.Properties.Name = albTgName;
    template.Resources.ECSService.Properties.LoadBalancers[0].ContainerPort = applicationPort;
    containerDefinition.Name = serviceMetaData.catalogData.serviceName + '-' + serviceMetaData.catalogData.region.toLowerCase();
    containerDefinition.Image = serviceMetaData.catalogData.image;
    containerDefinition.Memory = maxMemory;
    containerDefinition.MemoryReservation = minMemory;
    containerDefinition.PortMappings[0].ContainerPort = applicationPort;
    containerDefinition.HealthCheck.Command.push("curl -f http://localhost:" + healthCheckUri + " || exit 1");
    containerDefinition.LogConfiguration.Options["awslogs-group"] = "ecs/" +containerDefinition.Name ;
    //containerDefinition.LogConfiguration.Options["awslogs-group"] = "ecs/capsview-test-service8-dev";
    containerDefinition.LogConfiguration.Options["awslogs-region"] = process.env.AWS_REGION;
    containerDefinition.EnvironmentFiles = [];
    //template.Resources.LogGroup.Properties.LogGroupName = "ecs/" + serviceMetaData.catalogData.serviceName + '-' + serviceMetaData.catalogData.region.toLowerCase();
    //template.Resources.LogGroup.Properties.RetentionInDays = 14;// TODO:

    const envSpecAppEnv = `${serviceMetaData.catalogData.configbucket}/environments/${serviceMetaData.catalogData.product}/${serviceMetaData.catalogData.serviceName}/${serviceMetaData.catalogData.releaseIdentifier}/${serviceMetaData.catalogData.serviceName}.${serviceMetaData.catalogData.region.toLowerCase()}.env`;
    const envCommonAppEnv = `${serviceMetaData.catalogData.configbucket}/environments/${serviceMetaData.catalogData.product}/${serviceMetaData.catalogData.serviceName}/${serviceMetaData.catalogData.releaseIdentifier}/${serviceMetaData.catalogData.serviceName}.common.env`;
    const envSpecCommonEnv = `${serviceMetaData.catalogData.configbucket}/environments/${serviceMetaData.catalogData.product}/${serviceMetaData.catalogData.serviceName}/common.env`;


    containerDefinition.EnvironmentFiles.push(
        {
            "Value": "arn:aws:s3:::" + envSpecAppEnv,
            "Type": "s3"
        }
    );

    containerDefinition.EnvironmentFiles.push(
        {
            "Value": "arn:aws:s3:::" + envCommonAppEnv,
            "Type": "s3"
        }
    );


    /*
    containerDefinition.EnvironmentFiles.push(
        {
            "value": "arn:aws:s3:::" + envSpecCommonEnv,
            "type": "s3"
        }
    );
    */

    let secretNamespace = serviceMetaData.catalogData.product;
    let parameterNamespace = serviceMetaData.catalogData.product;

    logger.info(`Ref config data :${JSON.stringify(configData)}`);

    if (configData[serviceMetaData.catalogData.product]?.secretNamespace) {
        secretNamespace = configData[serviceMetaData.catalogData.product].secretNamespace;
        logger.info(`Overwriting product name for secret ref ${secretNamespace} instead of ${serviceMetaData.catalogData.product}`);
    }

    if (configData[serviceMetaData.catalogData.product]?.parameterNamespace) {
        parameterNamespace = configData[serviceMetaData.catalogData.product].parameterNamespace;
        logger.info(`Overwriting product name for parameter ref ${parameterNamespace} instead of ${serviceMetaData.catalogData.product}`);
    }

    for (const secretName in referanceSecrets) {
        containerDefinition.Secrets.push(
            {
                "Name": secretName,
                "ValueFrom": `arn:aws:secretsmanager:${process.env.AWS_REGION}:${subcriptionInfo.Account}:secret:/${secretNamespace}/${serviceMetaData.catalogData.region.toUpperCase()}/${referanceSecrets[secretName]}:${referanceSecrets[secretName]}::`
            }
        );
    }

    for (const referanceName in referanceValues) {
        containerDefinition.Secrets.push(
            {
                "Name": referanceName,
                "ValueFrom": `arn:aws:ssm:${process.env.AWS_REGION}:${subcriptionInfo.Account}:parameter/${parameterNamespace}/${serviceMetaData.catalogData.region.toUpperCase()}/${referanceValues[referanceName]}`
            }
        );
    }

    template.Resources.TaskDefinition.Properties.Volumes = [];
    containerDefinition.MountPoints = [];

    let mountPoints = serviceMetaData.regionSpec != undefined ? serviceMetaData.regionSpec.mountPoints:null;
    if(!mountPoints){
        mountPoints= serviceMetaData.commonSpec?.mountPoints?serviceMetaData.commonSpec.mountPoints:[];
    }
    if(Array.isArray(mountPoints) && mountPoints.length>0){
    mountPoints.forEach((mountpoint, idx) => {
        if (mountpoint?.sourcePath && mountpoint?.containerPath) {
                template.Resources.TaskDefinition.Properties.Volumes.push({
                    "Name": "fxsmount" + idx,
                    "Host": {
                        "SourcePath": mountpoint.sourcePath
                    }
                });
                containerDefinition.MountPoints.push({
                    "SourceVolume": "fxsmount" + idx,
                    "ContainerPath": mountpoint.containerPath
                });
            } else {
                logger.info(`Skipping mount points ${JSON.stringify(mountpoint)}`);
            }
        });
    }
    
    const taskRole = configData[serviceMetaData.catalogData.product]?.taskRole;
    if( taskRole ){
            template.Resources.TaskDefinition.Properties.TaskRoleArn = `arn:aws:iam::${subcriptionInfo.Account}:role/${configData[serviceMetaData.catalogData.product].taskRole}`;
    }else{
        logger.info(`Tsk role not defined removing it`);
        delete template.Resources.TaskDefinition.Properties.TaskRoleArn;

    }

   template.Resources.TaskDefinition.Properties.Family = serviceMetaData.catalogData.serviceName.toLowerCase() + '-' + serviceMetaData.catalogData.region.toLowerCase();
   template.Resources.TaskDefinition.Properties.ExecutionRoleArn = `arn:aws:iam::${subcriptionInfo.Account}:role/${configData[serviceMetaData.catalogData.product].taskecsExecutionRole}`;
    template.Resources.TaskDefinition.Properties.ContainerDefinitions[0] = containerDefinition;
}

function getPortAndHealthUri(serviceMetaData) {
    const logger = getAsyncContextLogger();

    let applicationPort = serviceMetaData.commonSpec.variables.APP_PORT;
    if (serviceMetaData.regionSpec?.variables?.APP_PORT) {
        applicationPort = serviceMetaData.regionSpec.variables.APP_PORT;
    }
    let contextPath = serviceMetaData.commonSpec.variables.APP_CONTEXT_PATH;
    let healthApi = serviceMetaData.commonSpec.variables.HEALTH_CHECK_PATH;
    if (serviceMetaData.regionSpec?.variables?.APP_CONTEXT_PATH) {
        contextPath = serviceMetaData.regionSpec.variables.APP_CONTEXT_PATH;
    }
    if (serviceMetaData.regionSpec?.variables?.HEALTH_CHECK_PATH) {
        healthApi = serviceMetaData.regionSpec.variables.HEALTH_CHECK_PATH;
    }

    if (typeof contextPath == 'string') {
        contextPath = contextPath.replace(/^\/+|\/+$/g, '');
    }else{
        logger.warn(`ContextPath not string ${JSON.stringify(contextPath)}`);
    }
    if(!healthApi){
        healthApi = '';
        logger.warn(`Health api not defined defaulting to empty`);
    }

    if (typeof healthApi == 'string') {
        healthApi = healthApi.replace(/^\/+|\/+$/g, '');
    }else{
        logger.warn(`HealthApi not string ${JSON.stringify(healthApi)}`);
    }
    
     
    let healthCheckUri = `${applicationPort}/${contextPath}/${healthApi}`;
    if(contextPath =='' || contextPath =='/'){
        healthCheckUri = `${applicationPort}/${healthApi}`;
    }

    return { applicationPort, healthCheckUri, healthApi,contextPath };
}

