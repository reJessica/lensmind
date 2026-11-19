package com.example.lensmind.control;

/** C 成员接入真实设备时实现此接口。坐标按未镜像预览，步长单位由适配器定义。 */
public interface DeviceGateway {
    DeviceStatus status();
    DeviceStatus move(String direction, int step);
    DeviceStatus home();
    DeviceStatus stop();

    record DeviceStatus(String mode, boolean connected, String state, int x, int y, String message) {}
}
