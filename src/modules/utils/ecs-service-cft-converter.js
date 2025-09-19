/**
 * Converts ECS service JSON to CloudFormation resource JSON
 * @param {Object} ecsJson - ECS service JSON object
 * @returns {Object} CloudFormation JSON object
 */
import { getAsyncContextLogger } from '../../utils/logger.js';

export async function ecsToCloudFormation(ecsJson) {
    // Create the base CloudFormation template
    const cfnTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Description: `CloudFormation template for ECS service: ${ecsJson.serviceName || 'Unknown'}`,
        Resources: {
            ECSService: {
                Type: 'AWS::ECS::Service',
                Properties: {
                    ServiceName: ecsJson.serviceName,
                    Cluster: ecsJson.clusterArn || { Ref: 'ECSCluster' },
                    TaskDefinition: ecsJson.taskDefinition || { Ref: 'TaskDefinition' },
                    DesiredCount: ecsJson.desiredCount,
                    LaunchType: ecsJson.launchType || 'FARGATE',
                }
            }
        }
    };
    // Add optional properties if they exist in the ECS JSON
    const serviceProps = cfnTemplate.Resources.ECSService.Properties;

    // Load balancers configuration
    if (ecsJson.loadBalancers && ecsJson.loadBalancers.length > 0) {
        serviceProps.LoadBalancers = ecsJson.loadBalancers;
    }

    // Network configuration
    if (ecsJson.networkConfiguration) {
        serviceProps.NetworkConfiguration = ecsJson.networkConfiguration;
    }

    // Placement constraints
    if (ecsJson.placementConstraints && ecsJson.placementConstraints.length > 0) {
        serviceProps.PlacementConstraints = ecsJson.placementConstraints;
    }

    // Placement strategy
    if (ecsJson.placementStrategy && ecsJson.placementStrategy.length > 0) {
        serviceProps.PlacementStrategy = ecsJson.placementStrategy;
    }

    // Health check grace period
    if (ecsJson.healthCheckGracePeriodSeconds) {
        serviceProps.HealthCheckGracePeriodSeconds = ecsJson.healthCheckGracePeriodSeconds;
    }

    // Deployment configuration
    if (ecsJson.deploymentConfiguration) {
        serviceProps.DeploymentConfiguration = ecsJson.deploymentConfiguration;
    }

    // Tags
    if (ecsJson.tags && ecsJson.tags.length > 0) {
        serviceProps.Tags = ecsJson.tags;
    }

    // ECS managed tags
    if (ecsJson.enableECSManagedTags !== undefined) {
        serviceProps.EnableECSManagedTags = ecsJson.enableECSManagedTags;
    }

    // Propagate tags
    if (ecsJson.propagateTags) {
        serviceProps.PropagateTags = ecsJson.propagateTags;
    }

    // Scheduling strategy
    if (ecsJson.schedulingStrategy) {
        serviceProps.SchedulingStrategy = ecsJson.schedulingStrategy;
    }

    // Service registries (for service discovery)
    if (ecsJson.serviceRegistries && ecsJson.serviceRegistries.length > 0) {
        serviceProps.ServiceRegistries = ecsJson.serviceRegistries;
    }

    // Enable execute command (ECS Exec)
    if (ecsJson.enableExecuteCommand !== undefined) {
        serviceProps.EnableExecuteCommand = ecsJson.enableExecuteCommand;
    }

    // Capacity provider strategy
    if (ecsJson.capacityProviderStrategy && ecsJson.capacityProviderStrategy.length > 0) {
        serviceProps.CapacityProviderStrategy = ecsJson.capacityProviderStrategy;
    }

    // Deployment controller
    if (ecsJson.deploymentController) {
        serviceProps.DeploymentController = ecsJson.deploymentController;
    }

    // Platform version (for FARGATE)
    if (ecsJson.platformVersion) {
        serviceProps.PlatformVersion = ecsJson.platformVersion;
    }

    // IAM role
    if (ecsJson.role) {
        serviceProps.Role = ecsJson.role;
    }

    // Force new deployment flag
    if (ecsJson.forceNewDeployment !== undefined) {
        serviceProps.ForceNewDeployment = ecsJson.forceNewDeployment;
    }

    return cfnTemplate;
}

/**
 * Converts CloudFormation JSON to ECS service JSON
 * @param {Object} cfnJson - CloudFormation JSON object
 * @returns {Object} ECS service JSON object
 */
export async function cloudFormationToEcs(cfnJson) {
    // Locate the ECS service in the CloudFormation template
    let ecsServiceResource = null;
    let ecsServiceName = null;

    if (cfnJson.Resources) {
        for (const [key, resource] of Object.entries(cfnJson.Resources)) {
            if (resource.Type === 'AWS::ECS::Service') {
                ecsServiceResource = resource;
                ecsServiceName = key;
                break;
            }
        }
    }

    if (!ecsServiceResource) {
        throw new Error('No AWS::ECS::Service resource found in the CloudFormation template');
    }

    const props = ecsServiceResource.Properties;

    // Create the ECS service JSON
    const ecsJson = {
        serviceName: props.ServiceName || ecsServiceName,
        clusterArn: props.Cluster,
        taskDefinition: props.TaskDefinition,
        desiredCount: props.DesiredCount,
        launchType: props.LaunchType || 'FARGATE'
    };

    // Add optional properties if they exist in the CFN template
    if (props.LoadBalancers) {
        ecsJson.loadBalancers = props.LoadBalancers;
    }

    if (props.NetworkConfiguration) {
        ecsJson.networkConfiguration = props.NetworkConfiguration;
    }

    if (props.PlacementConstraints) {
        ecsJson.placementConstraints = props.PlacementConstraints;
    }

    if (props.PlacementStrategy) {
        ecsJson.placementStrategy = props.PlacementStrategy;
    }

    if (props.HealthCheckGracePeriodSeconds) {
        ecsJson.healthCheckGracePeriodSeconds = props.HealthCheckGracePeriodSeconds;
    }

    if (props.DeploymentConfiguration) {
        ecsJson.deploymentConfiguration = props.DeploymentConfiguration;
    }

    if (props.Tags) {
        ecsJson.tags = props.Tags;
    }

    if (props.EnableECSManagedTags !== undefined) {
        ecsJson.enableECSManagedTags = props.EnableECSManagedTags;
    }

    if (props.PropagateTags) {
        ecsJson.propagateTags = props.PropagateTags;
    }

    if (props.SchedulingStrategy) {
        ecsJson.schedulingStrategy = props.SchedulingStrategy;
    }

    if (props.ServiceRegistries) {
        ecsJson.serviceRegistries = props.ServiceRegistries;
    }

    if (props.EnableExecuteCommand !== undefined) {
        ecsJson.enableExecuteCommand = props.EnableExecuteCommand;
    }

    if (props.CapacityProviderStrategy) {
        ecsJson.capacityProviderStrategy = props.CapacityProviderStrategy;
    }

    if (props.DeploymentController) {
        ecsJson.deploymentController = props.DeploymentController;
    }

    if (props.PlatformVersion) {
        ecsJson.platformVersion = props.PlatformVersion;
    }

    if (props.Role) {
        ecsJson.role = props.Role;
    }

    if (props.ForceNewDeployment !== undefined) {
        ecsJson.forceNewDeployment = props.ForceNewDeployment;
    }

    return ecsJson;
}
