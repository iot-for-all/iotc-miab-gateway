/* eslint-disable @typescript-eslint/no-empty-interface */
// ------------------------------------------------------------
//  Copyright (c) Microsoft Corporation. All rights reserved.
//  Licensed under the MIT License (MIT). See License.txt in the repo root for license information.
// ------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-unused-vars */
export namespace ErrorHandling {
    interface ErrorModel {
        code?: string;
        data?: any;
        details?: ErrorHandling.ErrorModel[];
        innerError?: ErrorHandling.InnerErrorModel;
        message?: string;
        target?: string;
    }
    interface InnerErrorModel {
        code?: string;
        innerError?: ErrorHandling.InnerErrorModel;
        message?: string;
    }
}
export namespace Models {
    export enum DeviceCredentialType {
        None = 0,
        X509Certificate = 1,
        SymmetricKey = 2
    }
    export enum DtdlVersion {
        V1 = 1,
        V2 = 2
    }
    export enum EndpointCredentialType {
        Anonymous = 0,
        Username = 1
    }
    export enum OpcAccessLevel {
        None = 0,
        CurrentRead = 1,
        CurrentWrite = 2,
        CurrentReadOrWrite = 3,
        HistoryRead = 4,
        HistoryWrite = 8,
        HistoryReadOrWrite = 12,
        SemanticChange = 16,
        StatusWrite = 32,
        TimestampWrite = 64
    }
    export enum OpcAttribute {
        NodeClass = 2,
        BrowseName = 3,
        DisplayName = 4,
        Description = 5,
        Value = 13,
        DataType = 14,
        ValueRank = 15,
        ArrayDimensions = 16,
        UserAccessLevel = 18
    }
    export enum OpcNodeClass {
        Object = 1,
        Variable = 2
    }
    export enum OpcValueRank {
        OneDimension = 1,
        OneOrMoreDimensions = 0,
        Scalar = -1,
        Any = -2,
        ScalarOrOneDimension = -3
    }
    export enum SecurityMode {
        Lowest = 0,
        Best = 1
    }
    interface AddOrUpdateAssetRequest {
        asset: Models.Asset;
        skipNodeValidation?: boolean;
    }
    interface AddOrUpdateAssetResponse {
    }
    interface Asset {
        assetId: string;
        deviceCredentials: Models.DeviceCredentials;
        ioTHubMessageProperties?: System.Collections.Generic.KeyValuePair<string, string>[];
        lastChanged?: Date;
        nodes: Models.NodeSubscriptionConfiguration[];
        opcEndpoint: Models.Endpoint;
        publishingIntervalMilliseconds?: number;
        queueSize?: number;
        samplingIntervalMilliseconds?: number;
    }
    interface BrowseNodesClientRequest {
        partialTimeoutSec?: number;
        request: Models.BrowseNodesRequest;
    }
    interface BrowseNodesRequest {
        depth?: number;
        includeReferenceType?: boolean;
        opcEndpoint: Models.Endpoint;
        queryHasReferences?: boolean;
        requestedAttributes?: Models.OpcAttribute[];
        requestedNodeClasses?: Models.OpcNodeClass[];
        startNode?: string;
    }
    interface BrowseNodesResponse {
        jobId?: string;
    }
    interface CancelChunkMethodRequest {
        jobId: string;
    }
    interface CancelChunkMethodResponse {
        canceled?: boolean;
    }
    interface ChunkMethodClientResponse<T> {
        payload?: T;
        status?: number;
    }
    interface ChunkMethodRequest {
        contentEncoding?: string;
        contentLength?: number;
        contentType?: string;
        payload?: Uint8Array | string;
        requestId?: string;
        requestOffset?: number;
        responseOffset?: number;
    }
    interface ChunkMethodResponse {
        contentEncoding?: string;
        contentLength?: number;
        contentType?: string;
        payload?: Uint8Array | string;
        requestId?: string;
        status?: number;
    }
    interface DeviceCredentials {
        idScope?: string;
        primaryKey?: string;
        secondaryKey?: string;
        type?: Models.DeviceCredentialType;
        x509Certificate?: Uint8Array | string;
    }
    interface Endpoint {
        credentials?: Models.EndpointCredentials;
        securityMode?: Models.SecurityMode;
        uri: string;
    }
    interface EndpointCredentials {
        credentialType?: Models.EndpointCredentialType;
        password?: string;
        username?: string;
    }
    interface FetchBrowsedNodesClientRequest {
        partialTimeoutSec?: number;
        request: Models.FetchBrowsedNodesRequest;
    }
    interface FetchBrowsedNodesRequest {
        continuationToken?: string;
        jobId: string;
    }
    interface FetchBrowsedNodesResponse {
        collectedNodeCount?: number;
        continuationToken?: string;
        jobId?: string;
        nodes?: Models.OpcNode[];
    }
    interface GenerateDtdlRequest {
        dtdlVersion?: Models.DtdlVersion;
        modelId?: string;
        modelVersion?: number;
        opcEndpoint: Models.Endpoint;
        opcNodes?: Models.OpcNodeIdentity[];
    }
    interface GenerateDtdlResponse {
        dtdlModelJson?: string;
        dtdlTelemetryMapping?: Models.NodeDtdlConfiguration[];
    }
    interface GetAllAssetsRequest {
    }
    interface GetAllAssetsResponse {
        assets?: Models.Asset[];
    }
    interface GetVersionRequest {
    }
    interface GetVersionResponse {
        features?: System.Collections.Generic.KeyValuePair<string, boolean>[];
        informationalVersion?: string;
        semanticVersion?: string;
    }
    interface ModuleShutdownRequest {
    }
    interface ModuleShutdownResponse {
    }
    interface NodeDtdlConfiguration {
        dtdlTelemetryName: string;
        dtdlTelemetryType: string;
        nodeId: string;
    }
    interface NodeSubscriptionConfiguration {
        displayName?: string;
        nodeId: string;
        publishingIntervalMilliseconds?: number;
        queueSize?: number;
        samplingIntervalMilliseconds?: number;
    }
    interface OpcDataValue {
        serverTimestamp?: Date;
        sourceTimestamp?: Date;
        status?: string;
        value?: any;
    }
    interface OpcNode {
        arrayDimensions?: Uint32Array;
        browseName?: string;
        dataType?: string;
        description?: string;
        displayName?: string;
        hasReferences?: boolean;
        nodeClass?: Models.OpcNodeClass;
        nodeId?: string;
        parentId?: string;
        referenceType?: string;
        status?: string;
        userAccessLevel?: Models.OpcAccessLevel;
        value?: Models.OpcDataValue;
        valueRank?: Models.OpcValueRank;
    }
    interface OpcNodeIdentity {
        dtdlTelemetryName?: string;
        nodeId?: string;
    }
    interface OpcReadNode {
        dataValue?: Models.OpcDataValue;
        nodeId: string;
    }
    interface OpcWriteNode {
        dataValue: Models.OpcDataValue;
        nodeId: string;
    }
    interface OpcWriteNodeResult {
        nodeId?: string;
        status?: string;
    }
    interface ReadValuesRequest {
        opcEndpoint: Models.Endpoint;
        opcReadNodes: Models.OpcReadNode[];
    }
    interface ReadValuesResponse {
        opcReadNodes?: Models.OpcReadNode[];
    }
    interface RemoveAllAssetsRequest {
    }
    interface RemoveAllAssetsResponse {
    }
    interface RemoveAssetRequest {
        assetId: string;
    }
    interface RemoveAssetResponse {
    }
    interface TestConnectionRequest {
        opcEndpoint: Models.Endpoint;
    }
    interface TestConnectionResponse {
    }
    interface WriteValuesRequest {
        opcEndpoint: Models.Endpoint;
        opcWriteNodes: Models.OpcWriteNode[];
    }
    interface WriteValuesResponse {
        opcWriteNodes?: Models.OpcWriteNodeResult[];
    }
}
export namespace System.Collections.Generic {
    interface KeyValuePair<TKey, TValue> {
        key?: TKey;
        value?: TValue;
    }
}
