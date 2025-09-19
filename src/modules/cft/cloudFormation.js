import {
    DescribeStacksCommand, CreateStackCommand,
    GetTemplateSummaryCommand, UpdateStackCommand, DeleteStackCommand,
    GetTemplateCommand, waitUntilStackCreateComplete,
    waitUntilStackUpdateComplete, waitUntilStackDeleteComplete,
    ValidateTemplateCommand
} from "@aws-sdk/client-cloudformation";
import { subcriptionInfo } from '../sts/sts.js';
import { createLogGroup } from '../cloud-watch/cloudWatch.js';

import { getClusterVpc } from "./resourceFinder.js";
import { getPermittedAlbs, checkALBListenerAvailableForPort, checkALBListenerRulesCapacity } from "../loadbalancer/elb.js";
import { getAsyncContextLogger } from '../../utils/logger.js';
import { cloudFormationClient } from '../../utils/awsClients.js';

const region = process.env.AWS_REGION || "us-east-1";

export async function createOrUpdateStack(stackName, stackInfo, template, region, product, configData) {
    const logger = getAsyncContextLogger();
    try {

        const templateBody = await dynamicTemplateUpdate(stackInfo, template, region, product, configData);

        logger.info(`CFT template : ${JSON.stringify(templateBody)}`);
        const validationStatus = await validateTemplate(templateBody);

        logger.info(`ValidationStatus : ${JSON.stringify(validationStatus)}`);
        const stackExists = await doesStackExist(stackName);

        logger.info(`Stack exists :${JSON.stringify(stackExists)}`);
        const WAIT_TIME_SECONDS = 900; // TODO make this configurable. 


        if (stackExists) {
            //const changes = await getStackChanges(stackName, templateBody);
            //logger.info(`Template: ${JSON.stringify(templateBody)} - changes to be applied: ${JSON.stringify(changes)}`);
            await updateStack(stackName, templateBody, WAIT_TIME_SECONDS);
        } else {
            logger.info(`Template: ${JSON.stringify(templateBody)}`);
            const logGroupName = templateBody.Resources.TaskDefinition.Properties.ContainerDefinitions[0].LogConfiguration.Options['awslogs-group'];
            await createLogGroup(logGroupName);
            await createStack(stackName, templateBody, WAIT_TIME_SECONDS);
        }
    } catch (error) {
        logger.error(`Error creating or updating stack:, ${error} : ${error.stack} :message :${error.message}`);
        if (error.message.includes('ROLLBACK_COMPLETE')) {
            //await deleteStack(stackName);
            // await createStack(stackName, templateBody);
        }
        await deleteStack(stackName);
        if(error.message.includes('TimeoutError')){
            throw new Error(`Service created , Health Check haven't returned Sucess within wait time :`);
        }
        throw new Error('Service creation failed :' + error);
    }
}

async function getStackChanges(stackName, newTemplateBody) {
    const logger = getAsyncContextLogger();
    //const currentTemplateSummary = await getTemplateSummary(currentTemplate);
    //const newTemplateSummary = await getTemplateSummary(newTemplateBody);

    // logger.info(JSON.stringify(currentTemplate));
    //logger.info(JSON.stringify(currentTemplateSummary));
    // Compare the summaries to identify changes
    const changes = {
        added: [],
        removed: [],
        modified: []
    };

    // Identify added and modified resources
    for (const [resourceId, resource] of Object.entries(newTemplateBody.Resources)) {
        if (!currentTemplate.Resources[resourceId]) {
            changes.added.push(resourceId);
        } else if (JSON.stringify(currentTemplate.Resources[resourceId]) !== JSON.stringify(resource)) {
            changes.modified.push(resourceId);
        }
    }

    // Identify removed resources
    for (const resourceId of Object.keys(currentTemplate.Resources)) {
        if (!newTemplateBody.Resources[resourceId]) {
            changes.removed.push(resourceId);
        }
    }

    return changes;
}

async function getCurrentTemplate(stackName) {
    const logger = getAsyncContextLogger();
    const command = new GetTemplateCommand({ StackName: stackName });
    const result = await cloudFormationClient.send(command);
    return JSON.parse(result.TemplateBody);
}

async function getTemplateSummary(templateBody) {
    const logger = getAsyncContextLogger();
    const command = new GetTemplateSummaryCommand({ TemplateBody: JSON.stringify(templateBody) });
    const result = await cloudFormationClient.send(command);
    return result;
}

async function validateTemplate(templateBody) {
    const logger = getAsyncContextLogger();
    const command = new ValidateTemplateCommand({ TemplateBody: JSON.stringify(templateBody) });
    const validationStatus = await cloudFormationClient.send(command);
    return validationStatus;
}

async function dynamicTemplateUpdate(stackInfo, template, region, product, configData) {
    const logger = getAsyncContextLogger();
    logger.info(JSON.stringify(subcriptionInfo));

    if (!stackInfo) { 
        let updatedTemplate = template;
        const clusterName = template.Resources.ECSService.Properties.Cluster;
        const vpcList = await getClusterVpc(clusterName);

        if (!vpcList.length) { 
            logger.error(`EC2 not available for cluster :${clusterName}`);
            throw new Error('EC2 not available for cluster :' + clusterName);
        }
        logger.info(`Vpc list ${JSON.stringify(vpcList)} for cluster${clusterName} `);
        updatedTemplate.Resources.ALBTargetGroup.Properties.VpcId = vpcList[0];

        const albsinRegion = await getPermittedAlbs({ Environment: [region] });

        for (const alb of albsinRegion) {
            logger.info(`${JSON.stringify(alb)} arn ${alb.LoadBalancerArn}`);
            const isUsedStats = await checkALBListenerAvailableForPort(alb.LoadBalancerArn, updatedTemplate.Resources.ALBListener.Properties.Port);
            if (isUsedStats.isPortInUse) { // Simplified check
                logger.error(`Requested port ${updatedTemplate.Resources.ALBListener.Properties.Port} in use dtls ${JSON.stringify(isUsedStats)} `)
                throw new Error(`Port ${updatedTemplate.Resources.ALBListener.Properties.Port} already in use `);
            }
        }
        let usableAlbArn = '';

        const albs = await getPermittedAlbs({ Environment: [region], Product: ['COMMON', product] });

        let whiteListedAlbs = [];
        let serviceConnectConfig = null;


        if (configData[region]?.[product]) {
            whiteListedAlbs = configData[region][product].alb ?? [];
            serviceConnectConfig = configData[region][product].serviceConnect;
        }

        if (serviceConnectConfig?.nameSpace) {
            if (updatedTemplate.Resources.ECSService.Properties.ServiceConnectConfiguration) {
                updatedTemplate.Resources.ECSService.Properties.ServiceConnectConfiguration.Namespace = serviceConnectConfig.nameSpace;
            } else {
                logger.info(`Service connect set as not required`);
            }

        } else if (updatedTemplate.Resources.ECSService.Properties.ServiceConnectConfiguration) {
            delete updatedTemplate.Resources.ECSService.Properties.ServiceConnectConfiguration;
            logger.info(`Neglecting service connect as config not found`);
        }

        for (const alb of albs) {
            logger.info(`${JSON.stringify(alb)} arn ${alb.LoadBalancerArn}`);
            const canAlbUsed = await checkALBListenerRulesCapacity(alb.LoadBalancerArn, 100, 100);
            if (canAlbUsed) {
                const commonAlbName = getStringBetweenLastSlashes(alb.LoadBalancerArn);
                if (whiteListedAlbs.length) { // Simplified check
                    if (whiteListedAlbs.includes(commonAlbName)) {
                        usableAlbArn = alb.LoadBalancerArn;
                        break;
                    } else {
                        logger.info(`${alb.LoadBalancerArn} not whitelisted for usage`);
                    }
                } else {
                    logger.info(`No white listing for alb usage `);
                    usableAlbArn = alb.LoadBalancerArn;
                    break;
                }

            }
        }

        if (!usableAlbArn) { // Simplified check for empty string
            logger.error(`No available ALB's found`);
            throw new Error('No ALB found to add Listner Mappings');
        } else {
            logger.info(`Using ${usableAlbArn} `);
            //usableAlbArn ='arn:aws:elasticloadbalancing:us-east-1:656646465724:loadbalancer/app/alb-hps-dev-06/aa58cc79266697b6';
        }
        updatedTemplate.Resources.ALBListener.Properties.LoadBalancerArn = usableAlbArn;
        return updatedTemplate;
    }

}

function getStringBetweenLastSlashes(str) {
    const match = str.match(/\/([^\/]+)\/[^\/]*$/);
    return match ? match[1] : null;
}
async function doesStackExist(stackName) {
    const logger = getAsyncContextLogger();
    try {
        const command = new DescribeStacksCommand({ StackName: stackName });
        const result = await cloudFormationClient.send(command);
        logger.info(`Stack : ${JSON.stringify(result)}`);
        return result.Stacks && result.Stacks.length > 0;
    } catch (error) {
        if (error.name === 'ValidationError') {
            return false;
        }
        throw error;
    }
}

async function createStack(stackName, templateBody , waitTime) {
    const logger = getAsyncContextLogger();
    const params = {
        StackName: stackName,
        TemplateBody: JSON.stringify(templateBody),
        Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
    };
    const command = new CreateStackCommand(params);
    await cloudFormationClient.send(command);
    const createStatus = await waitUntilStackCreateComplete({ client: cloudFormationClient, maxWaitTime: waitTime }, { StackName: stackName });
    logger.info(`Stack ${stackName} created successfully..${JSON.stringify(createStatus)}`);
}

async function updateStack(stackName, templateBody, waitTime) {
    const logger = getAsyncContextLogger();
    const params = {
        StackName: stackName,
        TemplateBody: JSON.stringify(templateBody),
        Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
    };
    const command = new UpdateStackCommand(params);
    await cloudFormationClient.send(command);
    await waitUntilStackUpdateComplete({ client: cloudFormationClient, maxWaitTime: waitTime }, { StackName: stackName });
    logger.info(`Stack ${stackName} updated successfully.`);
}

async function deleteStack(stackName) {
    const logger = getAsyncContextLogger();
    const command = new DeleteStackCommand({ StackName: stackName });
    await cloudFormationClient.send(command);
    await waitUntilStackDeleteComplete({ client: cloudFormationClient, maxWaitTime: 600 }, { StackName: stackName });
    logger.info(`Stack ${stackName} deleted successfully.`);
}