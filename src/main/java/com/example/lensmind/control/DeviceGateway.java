package com.example.lensmind.control;

/** C 成员接入真实设备时实现此接口。坐标按未镜像预览，步长单位由适配器定义。 */
public interface DeviceGateway {
    DeviceStatus status();
    DeviceStatus move(String direction, int step);
    DeviceStatus home();
    DeviceStatus stop();

    record DeviceStatus(String mode, boolean connected, String state, int x, int y, String message,
                        DeviceFrame frame, So101View so101) {
        public DeviceStatus(String mode, boolean connected, String state, int x, int y, String message,
                            DeviceFrame frame) {
            this(mode, connected, state, x, y, message, frame, null);
        }
    }

    record DeviceFrame(String id, String timestamp, int width, int height, String src) {}

    record So101View(double shoulderPanDegrees, double cameraYawDegrees, int cameraTravelMillimeters,
                     int cameraElevationMillimeters, double cameraPitchDegrees,
                     double[] cameraPositionMeters, String armView) {}
}
