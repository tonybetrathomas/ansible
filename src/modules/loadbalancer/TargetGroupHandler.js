import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { DescribeContainerInstancesCommand, ListContainerInstancesCommand } from "@aws-sdk/client-ecs";
import { CreateListenerCommand, CreateTargetGroupCommand, DescribeListenersCommand, 
    DescribeTargetGroupsCommand ,ModifyTargetGroupCommand,DeleteTargetGroupCommand} from "@aws-sdk/client-elastic-load-balancing-v2";
import { getAsyncContextLogger } from '../../utils/logger.js';
import { elbClient, ec2Client, ecsClient } from '../../utils/awsClients.js';

const region = process.env.AWS_REGION || "us-east-1"; 

// Constants for common log/error messages
const INSTANCES_NOT_FOUND_FOR_CLUSTER_MESSAGE = "Instances not found for cluster";
const TARGET_GROUP_NOT_FOUND_MESSAGE = "Target group not found.";
const DELETED_TARGET_GROUP_MESSAGE = "Deleted target group:";
const ERROR_DELETING_TARGET_GROUP_MESSAGE = "Error deleting target group:";
const ERROR_UPDATING_HEALTH_CHECK_MESSAGE = "Error updating health check:";
const GETTING_DETAILS_FOR_TG_MESSAGE = "Getting details for Tg";

export async function getTargetGroupDetails(tgArn) {

    const logger = getAsyncContextLogger();
    logger.info(`${GETTING_DETAILS_FOR_TG_MESSAGE} ${tgArn}`);
    const descTgCommand = new DescribeTargetGroupsCommand({
        TargetGroupArns: [tgArn]
    });

    const tgDtls = await elbClient.send(descTgCommand);
    return tgDtls;
}
export async function getAlbListnerDetails(albArn) {
    const logger = getAsyncContextLogger();

    const descTgCommand = new DescribeListenersCommand({
        LoadBalancerArn: albArn
    });

    const listeners = await elbClient.send(descTgCommand);
    return listeners;
}
export async function getClusterVpc(ecsClusterName) {
    const logger = getAsyncContextLogger();

    const descClusterCommand = new ListContainerInstancesCommand({
        cluster: ecsClusterName
    });
    let vpcList = [];
    const clusterInstanceDtls = await ecsClient.send(descClusterCommand);
    if (clusterInstanceDtls.containerInstanceArns.length > 0) {
        const descContainerInstanceCmd = new DescribeContainerInstancesCommand({
            cluster: ecsClusterName,
            containerInstances: clusterInstanceDtls.containerInstanceArns
        });
        const clusterInstances = await ecsClient.send(descContainerInstanceCmd);
        let ec2List = [];
        logger.info(JSON.stringify(clusterInstances));



        clusterInstances.containerInstances.forEach(instance => {
            ec2List.push(instance.ec2InstanceId);
        });
        logger.info(JSON.stringify(ec2List));

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
            logger.error(`Ec2InstanceDetails: ${JSON.stringify(ec2InstanceDetails)}`);
        }
    } else {
        logger.error(`${INSTANCES_NOT_FOUND_FOR_CLUSTER_MESSAGE} :${ecsClusterName}`);
        throw new Error(`${INSTANCES_NOT_FOUND_FOR_CLUSTER_MESSAGE} :" + ecsClusterName`);
    }


    return vpcList;
}

export async function createAlbListner(listenerDtls) {
    const logger = getAsyncContextLogger();

    const createListerCmd = new CreateListenerCommand({
        listenerDtls
    });
    const listener = await elbClient.send(createListerCmd);
    return listener;
}

export async function createTargetGroup(targetGrpDtls) {
    const logger = getAsyncContextLogger();

    const createTgCmd = new CreateTargetGroupCommand({
        targetGrpDtls
    });

    const tg = await elbClient.send(createTgCmd);
    return tg;
}

export async function deleteTargetGroup(targetGroupName) {
    const logger = getAsyncContextLogger();

    try {
        const describeCmd = new DescribeTargetGroupsCommand({
          Names: [targetGroupName]
        });
        const describeRes = await elbClient.send(describeCmd);
        const tg = describeRes.TargetGroups?.[0];
    
        if (!tg) { // Simplified check
          logger.error(`${TARGET_GROUP_NOT_FOUND_MESSAGE} "${targetGroupName}".`);
          return;
        }
        await deleteTgWithArn(tg.TargetGroupArn);
        logger.info(`${DELETED_TARGET_GROUP_MESSAGE} ${targetGroupName}`);
      } catch (err) {
        logger.error(`${ERROR_DELETING_TARGET_GROUP_MESSAGE} ${err.message}`, err.stack);
      }
}

export async function deleteTgWithArn(targetGroupArn) {
    const logger = getAsyncContextLogger();
    const deleteCmd = new DeleteTargetGroupCommand({
        TargetGroupArn: targetGroupArn
    });
    await elbClient.send(deleteCmd);
    logger.info(`${DELETED_TARGET_GROUP_MESSAGE} ${targetGroupArn}`);
}


export async function updateHealthCheckPath(targetGroupArn, healthCheckPath) {
    const logger = getAsyncContextLogger();
    try {
      const resp = await elbClient.send(
        new ModifyTargetGroupCommand({
          TargetGroupArn: targetGroupArn,
          HealthCheckPath: healthCheckPath,
        })
      );
  
      logger.info(`Health check updated: ${resp.TargetGroups[0].HealthCheckPath}`);
      return resp;
    } catch (err) {
      logger.error(`${ERROR_UPDATING_HEALTH_CHECK_MESSAGE} ${err.message}`, err.stack);
      throw err;
    }
  }

