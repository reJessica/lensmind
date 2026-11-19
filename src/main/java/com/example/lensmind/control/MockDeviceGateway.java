package com.example.lensmind.control;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** 纯内存模拟器：没有串口、舵机或网络设备调用，不代表 SO-101 真实坐标。 */
@Service
public class MockDeviceGateway implements DeviceGateway {
    private int x;
    private int y;
    private String state = "IDLE";
    private String message = "模拟控制服务就绪，真实机械臂未接入";

    @Override
    public synchronized DeviceStatus status() {
        return new DeviceStatus("MOCK", true, state, x, y, message);
    }

    @Override
    public synchronized DeviceStatus move(String direction, int step) {
        if ("STOPPED".equals(state)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "已停止，请先回初始位恢复模拟操作");
        }
        if (step < 1 || step > 5) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "模拟步长必须为 1～5");
        }
        int nextX = x;
        int nextY = y;
        switch (direction == null ? "" : direction) {
            case "LEFT" -> nextX -= step;
            case "RIGHT" -> nextX += step;
            case "UP" -> nextY += step;
            case "DOWN" -> nextY -= step;
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "不支持的方向");
        }
        if (Math.abs(nextX) > 20 || Math.abs(nextY) > 20) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "超出模拟工作范围（±20），调整未执行");
        }
        x = nextX;
        y = nextY;
        message = "已完成模拟机位微调";
        return status();
    }

    @Override
    public synchronized DeviceStatus home() {
        x = 0;
        y = 0;
        state = "IDLE";
        message = "已回模拟初始位";
        return status();
    }

    @Override
    public synchronized DeviceStatus stop() {
        state = "STOPPED";
        message = "模拟动作已停止；回初始位后恢复操作";
        return status();
    }
}
