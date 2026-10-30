% Sample MATLAB script: First-Order RC Filter Step Response
R = 10e3;      % 10 kOhm
C = 10e-6;     % 10 uF
tau = R * C;   % Time constant = 0.1 s

t = linspace(0, 0.5, 500);
Vin = 3.3;     % 3.3V Step
Vout = Vin * (1 - exp(-t / tau));

fprintf('RC Filter Analysis:\n');
fprintf('  Resistance: %.1f kOhm\n', R / 1e3);
fprintf('  Capacitance: %.1f uF\n', C / 1e6);
fprintf('  Time Constant (tau): %.3f s\n', tau);
fprintf('  98%% settling time: %.3f s\n', 4 * tau);

fig = figure('Name', 'RC Step Response', 'Position', [100, 100, 600, 400]);
plot(t * 1000, Vout, 'LineWidth', 2, 'Color', [0.2, 0.5, 0.9]);
hold on;
yline(Vin * 0.632, '--r', '63.2% (1 tau)');
yline(Vin, ':k', '3.3V Target');
grid on;
title('RC Low-Pass Filter Step Response');
xlabel('Time (ms)');
ylabel('Capacitor Voltage (V)');
legend('V_{out}(t)', 'Location', 'southeast');
