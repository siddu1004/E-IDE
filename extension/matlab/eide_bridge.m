function eide_bridge(port, expectedToken)
% E-IDE MATLAB Persistent Bridge
% Listens on 127.0.0.1:<port> for JSON-RPC commands with token authentication.

    if nargin < 2
        error('Usage: eide_bridge(port, token)');
    end

    if ischar(port) || isstring(port)
        port = str2double(port);
    end
    if isstring(expectedToken)
        expectedToken = char(expectedToken);
    end

    fprintf('EIDE_BRIDGE_STARTING: port=%d\n', port);

    try
        server = tcpserver("127.0.0.1", port);
        configureTerminator(server, "LF");
    catch err
        fprintf('EIDE_BRIDGE_ERROR: %s\n', err.message);
        return;
    end

    fprintf('EIDE_BRIDGE_READY: port=%d\n', port);

    keepRunning = true;
    while keepRunning
        try
            if server.Connected && server.NumBytesAvailable > 0
                line = readline(server);
                lineStr = strtrim(char(line));
                if isempty(lineStr)
                    continue;
                end

                resp = handleMessage(lineStr, expectedToken);
                respJson = jsonencode(resp);
                writeline(server, respJson);

                if isfield(resp, 'action') && strcmp(resp.action, 'exit')
                    keepRunning = false;
                end
            else
                pause(0.02);
            end
        catch loopErr
            fprintf('EIDE_BRIDGE_LOOP_ERR: %s\n', loopErr.message);
            pause(0.05);
        end
    end

    delete(server);
    fprintf('EIDE_BRIDGE_STOPPED\n');
    exit;
end

function resp = handleMessage(rawJson, expectedToken)
    try
        req = jsondecode(rawJson);
    catch jsonErr
        resp = struct('status', 'error', 'error', struct(...
            'identifier', 'EIDE:InvalidJson', ...
            'message', sprintf('Failed to parse JSON request: %s', jsonErr.message)));
        return;
    end

    % Verify token
    if ~isfield(req, 'token') || ~strcmp(req.token, expectedToken)
        resp = struct('status', 'error', 'error', struct(...
            'identifier', 'EIDE:Unauthorized', ...
            'message', 'Invalid or missing session token'));
        return;
    end

    if ~isfield(req, 'cmd')
        resp = struct('status', 'error', 'error', struct(...
            'identifier', 'EIDE:MissingCommand', ...
            'message', 'Missing "cmd" property in request'));
        return;
    end

    cmd = req.cmd;
    args = struct();
    if isfield(req, 'args') && isstruct(req.args)
        args = req.args;
    end

    try
        switch cmd
            case 'ping'
                resp = struct('status', 'ok', 'result', 'pong');

            case 'runScript'
                resp = executeRunScript(args);

            case 'evalFigureExport'
                resp = executeFigureExport(args);

            case 'loadModel'
                resp = executeLoadModel(args);

            case 'getModelGraph'
                resp = executeGetModelGraph(args);

            case 'setParam'
                resp = executeSetParam(args);

            case 'addLine'
                resp = executeAddLine(args);

            case 'deleteLine'
                resp = executeDeleteLine(args);

            case 'simulate'
                resp = executeSimulate(args);

            case 'closeModel'
                resp = executeCloseModel(args);

            case 'exit'
                resp = struct('status', 'ok', 'result', 'bye', 'action', 'exit');

            otherwise
                resp = struct('status', 'error', 'error', struct(...
                    'identifier', 'EIDE:UnknownCommand', ...
                    'message', sprintf('Unknown command: %s', cmd)));
        end
    catch cmdErr
        resp = struct('status', 'error', 'error', struct(...
            'identifier', cmdErr.identifier, ...
            'message', cmdErr.message));
    end
end

function resp = executeRunScript(args)
    if ~isfield(args, 'path') || isempty(args.path)
        error('EIDE:InvalidArgument', 'Missing "path" argument for runScript');
    end
    scriptPath = args.path;
    [scriptDir, scriptName, ~] = fileparts(scriptPath);

    origDir = pwd;
    cleanup = onCleanup(@() cd(origDir));
    if ~isempty(scriptDir)
        cd(scriptDir);
    end

    % Clear any existing figures before run to know what is new
    close all hidden;

    % Execute script and capture command window output
    evalCommand = sprintf('run(''%s'');', scriptPath);
    output = evalc(evalCommand);

    % Export any created figures
    exportDir = tempdir;
    if isfield(args, 'exportDir') && ~isempty(args.exportDir)
        exportDir = args.exportDir;
    end
    figExport = exportOpenFigures(exportDir);

    resp = struct('status', 'ok', 'result', struct(...
        'output', output, ...
        'figures', {figExport}));
end

function resp = executeFigureExport(args)
    exportDir = tempdir;
    if isfield(args, 'exportDir') && ~isempty(args.exportDir)
        exportDir = args.exportDir;
    end
    figs = exportOpenFigures(exportDir);
    resp = struct('status', 'ok', 'result', struct('figures', {figs}));
end

function figFiles = exportOpenFigures(exportDir)
    figFiles = {};
    figs = findall(groot, 'Type', 'figure');
    for i = 1:numel(figs)
        f = figs(i);
        outName = fullfile(exportDir, sprintf('eide_fig_%d_%d.png', round(posixtime(datetime('now'))*1000), i));
        try
            exportgraphics(f, outName, 'Resolution', 150);
            figFiles{end+1} = outName; %#ok<AGROW>
        catch exportErr
            fprintf('Export error: %s\n', exportErr.message);
        end
    end
end

function resp = executeLoadModel(args)
    if ~isfield(args, 'path') || isempty(args.path)
        error('EIDE:InvalidArgument', 'Missing "path" argument for loadModel');
    end
    [~, modelName] = fileparts(args.path);
    if ~bdIsLoaded(modelName)
        load_system(args.path);
    end
    resp = struct('status', 'ok', 'result', struct('model', modelName, 'loaded', true));
end

function resp = executeGetModelGraph(args)
    if ~isfield(args, 'path') || isempty(args.path)
        error('EIDE:InvalidArgument', 'Missing "path" argument for getModelGraph');
    end
    [~, modelName] = fileparts(args.path);
    if ~bdIsLoaded(modelName)
        load_system(args.path);
    end

    % Query top-level blocks
    rawBlocks = find_system(modelName, 'SearchDepth', 1, 'Type', 'block');
    blocks = {};
    for i = 1:numel(rawBlocks)
        b = rawBlocks{i};
        bName = get_param(b, 'Name');
        bType = get_param(b, 'BlockType');
        bPos = get_param(b, 'Position'); % [left top right bottom]
        bPorts = get_param(b, 'Ports');   % [in out enable trigger state lconn rconn]

        bStruct = struct(...
            'name', bName, ...
            'type', bType, ...
            'position', bPos, ...
            'ports', bPorts);
        blocks{end+1} = bStruct; %#ok<AGROW>
    end

    % Query lines
    rawLines = find_system(modelName, 'FindAll', 'on', 'Type', 'line');
    lines = {};
    for i = 1:numel(rawLines)
        ln = rawLines(i);
        srcBlockH = get_param(ln, 'SrcBlockHandle');
        dstBlockH = get_param(ln, 'DstBlockHandle');
        srcPortH = get_param(ln, 'SrcPortHandle');
        dstPortH = get_param(ln, 'DstPortHandle');

        srcName = '';
        srcPort = 0;
        dstName = '';
        dstPort = 0;
        if ishandle(srcBlockH) && srcBlockH > 0
            srcName = get_param(srcBlockH, 'Name');
        end
        if ishandle(srcPortH) && srcPortH > 0
            srcPort = get_param(srcPortH, 'PortNumber');
        end
        if ishandle(dstBlockH) && dstBlockH > 0
            dstName = get_param(dstBlockH, 'Name');
        end
        if ishandle(dstPortH) && dstPortH > 0
            dstPort = get_param(dstPortH, 'PortNumber');
        end

        lStruct = struct(...
            'srcBlock', srcName, ...
            'srcPort', srcPort, ...
            'dstBlock', dstName, ...
            'dstPort', dstPort);
        lines{end+1} = lStruct; %#ok<AGROW>
    end

    resp = struct('status', 'ok', 'result', struct(...
        'model', modelName, ...
        'blocks', {blocks}, ...
        'lines', {lines}));
end

function resp = executeSetParam(args)
    if ~isfield(args, 'path') || ~isfield(args, 'block') || ~isfield(args, 'param') || ~isfield(args, 'value')
        error('EIDE:InvalidArgument', 'setParam requires path, block, param, and value');
    end
    [~, modelName] = fileparts(args.path);
    if ~bdIsLoaded(modelName)
        load_system(args.path);
    end

    fullBlock = [modelName '/' args.block];
    val = args.value;
    if isnumeric(val)
        val = num2str(val);
    end
    set_param(fullBlock, args.param, val);
    save_system(modelName);

    resp = struct('status', 'ok', 'result', struct('saved', true, 'block', args.block, 'param', args.param, 'value', val));
end

function resp = executeAddLine(args)
    if ~isfield(args, 'path') || ~isfield(args, 'src') || ~isfield(args, 'dst')
        error('EIDE:InvalidArgument', 'addLine requires path, src, and dst');
    end
    [~, modelName] = fileparts(args.path);
    if ~bdIsLoaded(modelName)
        load_system(args.path);
    end

    h = add_line(modelName, args.src, args.dst, 'autorouting', 'on');
    save_system(modelName);

    resp = struct('status', 'ok', 'result', struct('lineHandle', h, 'saved', true));
end

function resp = executeDeleteLine(args)
    if ~isfield(args, 'path') || ~isfield(args, 'src') || ~isfield(args, 'dst')
        error('EIDE:InvalidArgument', 'deleteLine requires path, src, and dst');
    end
    [~, modelName] = fileparts(args.path);
    if ~bdIsLoaded(modelName)
        load_system(args.path);
    end

    delete_line(modelName, args.src, args.dst);
    save_system(modelName);

    resp = struct('status', 'ok', 'result', struct('deleted', true, 'saved', true));
end

function resp = executeSimulate(args)
    if ~isfield(args, 'path') || isempty(args.path)
        error('EIDE:InvalidArgument', 'Missing "path" argument for simulate');
    end
    [~, modelName] = fileparts(args.path);
    if ~bdIsLoaded(modelName)
        load_system(args.path);
    end

    % Configure logging if not enabled
    set_param(modelName, 'SignalLogging', 'on');
    set_param(modelName, 'SignalLoggingName', 'logsout');
    set_param(modelName, 'SaveOutput', 'on');
    set_param(modelName, 'OutputSaveName', 'yout');
    set_param(modelName, 'SaveTime', 'on');
    set_param(modelName, 'TimeSaveName', 'tout');

    if isfield(args, 'stopTime') && ~isempty(args.stopTime)
        stopTimeStr = num2str(args.stopTime);
        simOut = sim(modelName, 'StopTime', stopTimeStr, 'ReturnWorkspaceOutputs', 'on');
    else
        simOut = sim(modelName, 'ReturnWorkspaceOutputs', 'on');
    end

    signals = {};

    % 1. Extract from logsout
    try
        logsout = simOut.get('logsout');
        if ~isempty(logsout) && isa(logsout, 'Simulink.SimulationData.Dataset')
            for i = 1:logsout.numElements
                elem = logsout.get(i);
                sigName = elem.Name;
                if isempty(sigName)
                    sigName = sprintf('Signal_%d', i);
                end
                
                % Time series values
                if isa(elem.Values, 'timeseries')
                    t = elem.Values.Time(:)';
                    d = elem.Values.Data(:)';
                    signals{end+1} = struct('name', sigName, 'time', t, 'values', d); %#ok<AGROW>
                end
            end
        end
    catch logsErr
        fprintf('Error extracting logsout: %s\n', logsErr.message);
    end

    % 2. Extract from yout / tout if signals is still empty
    if isempty(signals)
        try
            tout = simOut.get('tout');
            yout = simOut.get('yout');
            if ~isempty(tout) && ~isempty(yout)
                if isnumeric(yout) && ismatrix(yout)
                    numCols = size(yout, 2);
                    for col = 1:numCols
                        signals{end+1} = struct(...
                            'name', sprintf('yout_%d', col), ...
                            'time', tout(:)', ...
                            'values', yout(:, col)'); %#ok<AGROW>
                    end
                end
            end
        catch youtErr
            fprintf('Error extracting yout: %s\n', youtErr.message);
        end
    end

    % 3. Extract from simlog (Simscape logging) if available
    try
        simlog = simOut.find('simlog');
        if ~isempty(simlog)
            simlogSigs = extractSimlogNodes(simlog, '');
            for s = 1:numel(simlogSigs)
                signals{end+1} = simlogSigs{s}; %#ok<AGROW>
            end
        end
    catch simlogErr
        fprintf('Error extracting simlog: %s\n', simlogErr.message);
    end

    resp = struct('status', 'ok', 'result', struct(...
        'model', modelName, ...
        'signals', {signals}));
end

function nodes = extractSimlogNodes(node, prefix)
    nodes = {};
    if isempty(node)
        return;
    end
    try
        if isa(node, 'simscape.logging.Node')
            curName = node.id;
            if ~isempty(prefix)
                curName = [prefix '.' curName];
            end
            % If it has series data
            if node.hasSeries
                series = node.series;
                t = series.time(:)';
                v = series.values(:)';
                nodes{end+1} = struct('name', curName, 'time', t, 'values', v);
            else
                % Recurse through children
                childNames = node.childIds;
                for c = 1:numel(childNames)
                    cNode = node.(childNames{c});
                    sub = extractSimlogNodes(cNode, curName);
                    for s = 1:numel(sub)
                        nodes{end+1} = sub{s}; %#ok<AGROW>
                    end
                end
            end
        end
    catch
        % ignore unparseable nodes
    end
end

function resp = executeCloseModel(args)
    if ~isfield(args, 'path') || isempty(args.path)
        error('EIDE:InvalidArgument', 'Missing "path" argument for closeModel');
    end
    [~, modelName] = fileparts(args.path);
    if bdIsLoaded(modelName)
        close_system(modelName, 0);
    end
    resp = struct('status', 'ok', 'result', struct('model', modelName, 'closed', true));
end
