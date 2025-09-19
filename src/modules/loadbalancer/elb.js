import {
  DescribeRulesCommand, DescribeLoadBalancersCommand, ModifyListenerCommand,
  DescribeTagsCommand, DescribeTargetGroupsCommand, DescribeListenersCommand, DeleteListenerCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { getAsyncContextLogger } from '../../utils/logger.js';
import { elbClient } from '../../utils/awsClients.js';

const region = process.env.AWS_REGION || "us-east-1";

const NO_ALBS_FOUND_MESSAGE = 'No Application Load Balancers found';
const ALB_TYPE_APPLICATION = 'application';
const NO_LISTENER_FOUND_MESSAGE = 'No listener found on port';
const DELETED_LISTENER_MESSAGE = 'Deleted listener on port';
const ERROR_DELETING_LISTENER_MESSAGE = 'Error deleting listener:';
const ERROR_FETCHING_ALBS_BY_TAG_MESSAGE = 'Error fetching ALBs by tag:';
const ERROR_DESCRIBING_LISTENER_MESSAGE = 'Error describing listener:';
const ERROR_DESCRIBING_TARGET_GROUP_MESSAGE = 'Error describing target group:';

export async function describeTargetGroup(targetGroupName) {
  const logger = getAsyncContextLogger();
  try {
    const params = {
      Names: [targetGroupName]
    };
    const command = new DescribeTargetGroupsCommand(params);
    const result = await elbClient.send(command);
    return result.TargetGroups?.length > 0 ? result.TargetGroups[0] : null; // Simplified check
  } catch (error) {
    logger.error(`${ERROR_DESCRIBING_TARGET_GROUP_MESSAGE} ${error.message}`, error.stack);
    throw error;
  }
}

export async function describeListener(listenerArn) {
  const logger = getAsyncContextLogger();
  try {
    const params = {
      ListenerArns: [listenerArn]
    };
    const command = new DescribeListenersCommand(params);
    const result = await elbClient.send(command);
    return result.Listeners?.length > 0 ? result.Listeners[0] : null; // Simplified check
  } catch (error) {
    logger.error(`${ERROR_DESCRIBING_LISTENER_MESSAGE} ${error.message}`, error.stack);
    throw error;
  }
}

export async function getPermittedAlbs(tagFilters) {
  const logger = getAsyncContextLogger();

  try {

    const describeCommand = new DescribeLoadBalancersCommand({});
    const loadBalancersResponse = await elbClient.send(describeCommand);

    loadBalancersResponse.LoadBalancers.sort((a, b) => {
        const nameA = a.LoadBalancerName.toUpperCase();
        const nameB = b.LoadBalancerName.toUpperCase();
        if (nameA < nameB) {
          return -1;
        }
        if (nameA > nameB) {
          return 1;
        }
        // names are equal
        return 0;
      });
    const albs = loadBalancersResponse.LoadBalancers.filter(
      lb => lb.Type === ALB_TYPE_APPLICATION
    );

    if (!albs.length) {
      logger.error(NO_ALBS_FOUND_MESSAGE);
      return [];
    }else{
      logger.info(`${albs.length} ALBs found in ${region} region`);
    }

    const albArns = albs.map(alb => alb.LoadBalancerArn);
    const tagsCommand = new DescribeTagsCommand({
      ResourceArns: albArns
    });

    const tagsResponse = await elbClient.send(tagsCommand);

    const matchingALBs = tagsResponse.TagDescriptions.filter(tagDescription => {
      const alb = albs.find(lb => lb.LoadBalancerArn === tagDescription.ResourceArn);
      if (!alb) return false;

      return Object.entries(tagFilters).every(([tagKey, permittedValues]) => {
        return tagDescription.Tags.some(tag =>
          tag.Key === tagKey &&
          tag.Value &&
          permittedValues.some(permittedValue =>
            tag.Value.toLowerCase() === permittedValue.toLowerCase()
          )
        );
      });
    }).map(tagDescription => ({
      ...albs.find(lb => lb.LoadBalancerArn === tagDescription.ResourceArn),
      Tags: tagDescription.Tags
    }));

    return matchingALBs;

  } catch (error) {
    logger.error(`${ERROR_FETCHING_ALBS_BY_TAG_MESSAGE} ${error.message}`, error.stack);
    throw error;
  }
}

export async function checkALBListenerAvailableForPort(albArn, applicationPort) {
  const logger = getAsyncContextLogger();
  const listnerAvailbilityStatus = { isPortInUse: false, dtls: {} };

  logger.info(`In port check ${albArn} :${applicationPort}`);
  // Get all listeners for the ALB
  const listenersCommand = new DescribeListenersCommand({
    LoadBalancerArn: albArn
  });
  const listenersResponse = await elbClient.send(listenersCommand);

  //logger.info(`listenersResponse : ${JSON.stringify(listenersResponse)}`);

  const foundListener = listenersResponse.Listeners.find(listener => listener.Port === applicationPort);
  if (foundListener) {
    listnerAvailbilityStatus.isPortInUse = true;
    listnerAvailbilityStatus.dtls = foundListener.DefaultActions;
  }
  return listnerAvailbilityStatus;

}

export async function checkALBListenerRulesCapacity(albArn, MAX_RULES_PER_ALB) {
  const logger = getAsyncContextLogger();
  const listenersCommand = new DescribeListenersCommand({
    LoadBalancerArn: albArn
  });
  const listenersResponse = await elbClient.send(listenersCommand);
  return listenersResponse.Listeners.length < MAX_RULES_PER_ALB; // Simplified check
}
export async function findAndDropALBListenerMapping(tagFilters, portToDelete) {
  const logger = getAsyncContextLogger();
  const permitedAlbs = await getPermittedAlbs(tagFilters);
  for (const alb of permitedAlbs) {
    logger.info(`${JSON.stringify(alb)} arn ${alb.LoadBalancerArn}`);
    await dropALBListenerMapping(alb.LoadBalancerArn, portToDelete);
  }
}

export async function dropALBListenerMapping(loadBalancerArn, portToDelete) {
  const logger = getAsyncContextLogger();

  try {
    const describeCmd = new DescribeListenersCommand({
      LoadBalancerArn: loadBalancerArn
    });

    const response = await elbClient.send(describeCmd);
    const listener = response.Listeners.find(l => l.Port === portToDelete);

    if (!listener) {
      logger.error(`${NO_LISTENER_FOUND_MESSAGE} ${portToDelete}`);
      return;
    }

    console.log(`lister to be droppped :${JSON.stringify(listener)}`);


    const modifyListner = new ModifyListenerCommand({
      ListenerArn: listener.ListenerArn,
      DefaultActions: [
        {
          Type: "fixed-response",
          FixedResponseConfig: {
            StatusCode: "404",
            ContentType: "text/plain",
            MessageBody: "Service no longer available"
          }
        }
      ]
    });

    await elbClient.send(modifyListner);


    const deleteCmd = new DeleteListenerCommand({
      ListenerArn: listener.ListenerArn
    });

    await elbClient.send(deleteCmd);
    logger.info(`${DELETED_LISTENER_MESSAGE} ${portToDelete}`);
  } catch (err) {
    logger.error(`${ERROR_DELETING_LISTENER_MESSAGE} ${err.message}`, err.stack);
    throw err;
  }

}
