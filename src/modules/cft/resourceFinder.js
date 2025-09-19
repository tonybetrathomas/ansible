import { DescribeStacksCommand, ListStacksCommand, ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { DescribeContainerInstancesCommand, ListContainerInstancesCommand } from "@aws-sdk/client-ecs";
import { getAsyncContextLogger } from '../../utils/logger.js';
import { cloudFormationClient, ec2Client, ecsClient } from '../../utils/awsClients.js';


const region = process.env.AWS_REGION || "us-east-1";
const CLUSTER_INSTANCES_NOT_FOUND_ERROR_MESSAGE = "Instances not found for cluster";

export async function findStackByResource(resourceIdentifier) {
    const logger = getAsyncContextLogger();
    logger.info(`ResourceIdentifier :${JSON.stringify(resourceIdentifier)}`);
    const stacks = await listAllStacks(resourceIdentifier);
    logger.info(`Found ${stacks.length} stacks.`);
    for (const stack of stacks) {
        if (stack.StackName) { // Simplified check for null
            const resources = await listStackResources(stack.StackName);

            logger.info(`Resources: ${JSON.stringify(resources)}`);
            if (resources.some(resource => resource.LogicalResourceId == resourceIdentifier.serviceType
                && resource.PhysicalResourceId.includes(resourceIdentifier.resource))) {
                return { stackName: stack.StackName, resources: resources };
            }
        } else {
            logger.info(`Stack name empty :${JSON.stringify(stack)}`);
        }
    }
    return null;
}

async function listAllStacks(resourceIdentifier) {
    const logger = getAsyncContextLogger();

    let nextToken;
    let matchingStacks = [];

    do {
        const command = new ListStacksCommand({
            NextToken: nextToken, 
            StackStatusFilter: [
                "CREATE_COMPLETE",
                "UPDATE_COMPLETE",
                "UPDATE_ROLLBACK_COMPLETE",
                "ROLLBACK_COMPLETE"
            ]
        });
        const response = await cloudFormationClient.send(command);
        const stacks = response.StackSummaries.filter(stack =>
            stack.StackName.toLowerCase().includes(resourceIdentifier.serviceName.toLowerCase())
            &&stack.StackName.toLowerCase().includes(resourceIdentifier.region.toLowerCase())
            &&stack.StackName.toLowerCase().includes(resourceIdentifier.clusterName.toLowerCase()));
        matchingStacks.push(...stacks);
        nextToken = response.NextToken;
    } while (nextToken);

    logger.info(`Filtered stacks length :${matchingStacks.length}`);
    return matchingStacks;

}

async function listStackResources(stackName) {
    const logger = getAsyncContextLogger();
    const command = new ListStackResourcesCommand({ StackName: stackName });
    const result = await cloudFormationClient.send(command);
    logger.info(`Stack summary :${JSON.stringify(result.StackResourceSummaries)}`);
    return result.StackResourceSummaries || [];
}

export async function getClusterVpc(clusterName) {
    const logger = getAsyncContextLogger();
    const descClusterCommand = new ListContainerInstancesCommand({
        cluster: clusterName
    });
    let vpcList = [];
    const clusterInstanceDtls = await ecsClient.send(descClusterCommand);
    if (!clusterInstanceDtls.containerInstanceArns.length) { // Simplified check
        logger.error(`${CLUSTER_INSTANCES_NOT_FOUND_ERROR_MESSAGE}:${clusterName}`);
        throw new Error(`${CLUSTER_INSTANCES_NOT_FOUND_ERROR_MESSAGE}:" + clusterName`);
    }
    
    const descContainerInstanceCmd = new DescribeContainerInstancesCommand({
        cluster: clusterName,
        containerInstances: clusterInstanceDtls.containerInstanceArns
    });
    const clusterInstances = await ecsClient.send(descContainerInstanceCmd);
    let ec2List = [];
    // logger.info(`instances: ${JSON.stringify(clusterInstances)}`);


    clusterInstances.containerInstances.forEach(instance => {
        ec2List.push(instance.ec2InstanceId);
    });
    //logger.info(`ec2 list: ${JSON.stringify(ec2List)}`);

    //const ids=clusterInstances.containerInstances.attributes.filter(attribute => attribute.name=='ecs.vpc-id');
    //logger.info(ids);
    const desInstanceCmd = new DescribeInstancesCommand({
        InstanceIds: ec2List
    });

    const ec2InstanceDetails = await ec2Client.send(desInstanceCmd);
    try {

        ec2InstanceDetails.Reservations.forEach(reservation => {
            reservation.Instances.forEach(instance => {
                instance.NetworkInterfaces.forEach(nwInterface => {
                    vpcList.push(nwInterface.VpcId);
                });
            });
        });
    } catch (error) {
        logger.error(`${error.message}`, error.stack);
        logger.error(`EC2 Instance Details: ${JSON.stringify(ec2InstanceDetails)}`);
    }
    
    logger.info(`Vpc : ${JSON.stringify(vpcList)}`);
    return vpcList;
}

