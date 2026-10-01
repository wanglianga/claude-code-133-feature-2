import { useState } from 'react';
import { Alert, Button, Card, Modal, Select, Space, Tag, Timeline, Typography, message, Input } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { api, TICKET_TYPE, TRANSFER_STATUS } from '../api';

const DIR_TEXT: Record<string, string> = { forward: '上行', backward: '下行', loop: '环线' };

export default function TransferPlanCard({
  plan, role, trips, onChanged, defaultOpen = false,
}: {
  plan: any;
  role: 'visitor' | 'staff' | 'driver' | 'dispatch' | 'service';
  trips?: any[];
  onChanged?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const st = TRANSFER_STATUS[plan.status] || { text: plan.status, color: 'default' };
  const active = ['proposed', 'accepted'].includes(plan.status);

  const act = async (fn: () => Promise<any>, ok: string) => {
    try { await fn(); message.success(ok); onChanged?.(); }
    catch (e: any) { message.error(e.message); }
  };

  const accept = () => Modal.confirm({
    title: '接受换乘方案？',
    content: `请在「${plan.alightStationName}」下车，由站务引导免费换乘对向接驳车，无需重新排队。预计额外等待约 ${plan.extraWaitMinutes} 分钟。`,
    okText: '接受方案',
    onOk: async () => {
      await api.post(`/transfers/plans/${plan.id}/accept`, {});
      message.success('已接受，行程变化已同步');
      onChanged?.();
    },
  });

  const decline = () => Modal.confirm({
    title: '不接受该换乘方案？',
    content: <Space direction="vertical" style={{ marginTop: 8, width: '100%' }}>
      <Typography.Text type="secondary">平台仍会记录您的选择，客服可继续协助退改签。</Typography.Text>
      <Input.TextArea id="wb-decline-reason" rows={2} placeholder="原因（可选），如：希望直接退票" />
    </Space>,
    okText: '不接受', okButtonProps: { danger: true },
    onOk: async () => {
      const reason = (document.getElementById('wb-decline-reason') as HTMLTextAreaElement)?.value || '';
      await api.post(`/transfers/plans/${plan.id}/decline`, { reason });
      message.success('已记录，客服将继续协助');
      onChanged?.();
    },
  });

  const archive = () => Modal.confirm({
    title: '确认行程变化并归档？',
    onOk: async () => {
      await api.post(`/transfers/plans/${plan.id}/archive`, {});
      message.success('已归档，感谢确认');
      onChanged?.();
    },
  });

  const complete = () => Modal.confirm({
    title: `确认游客已在「${plan.alightStationName}」完成换乘？`,
    content: <Space direction="vertical" style={{ marginTop: 8 }}>
      <span>登记实际额外等待（分钟）：</span>
      <Input id="wb-wait" type="number" defaultValue={plan.extraWaitMinutes || 5} style={{ width: 200 }} />
    </Space>,
    onOk: async () => {
      const min = Number((document.getElementById('wb-wait') as HTMLInputElement)?.value || 0);
      await api.post(`/transfers/plans/${plan.id}/complete`, { actualExtraWaitMinutes: min });
      message.success('换乘已完成，等待游客端确认归档');
      onChanged?.();
    },
  });

  const assignPickup = () => {
    let tripId: number | undefined;
    Modal.confirm({
      title: '调度锁定接驳班次',
      content: <Space direction="vertical" style={{ marginTop: 8, width: '100%' }}>
        <Typography.Text type="secondary">
          需在「{plan.alightStationName}」接回游客前往「{plan.destStationName}」
          {plan.needWheelchair ? '，请选择带轮椅位的车辆' : ''}
        </Typography.Text>
        <Select style={{ width: '100%' }} placeholder="选择经过下车站的对向班次"
          onChange={v => { tripId = v; }}
          options={(trips || []).map(t => ({
            value: t.id,
            label: `${t.code} ${DIR_TEXT[t.direction] || ''} ${t.originName}→${t.destName} 余${t.seatsLeft}座${t.vehicleAccessible ? ' ♿' : ''}`,
          }))} />
      </Space>,
      onOk: async () => {
        if (!tripId) return message.warning('请先选择接驳班次');
        await api.post(`/transfers/plans/${plan.id}/assign-pickup`, { tripId });
        message.success('接驳班次已锁定并通知相关方');
        onChanged?.();
      },
    });
  };

  return (
    <Card
      size="small"
      style={{ borderColor: active ? '#fa8c16' : undefined, marginBottom: 10 }}
      title={<Space wrap>
        <SwapOutlined style={{ color: '#fa8c16' }} />
        <b>{plan.code}</b>
        <Tag color={st.color}>{st.text}</Tag>
        <Tag>{TICKET_TYPE[plan.ticketType] || plan.typeLabel}</Tag>
        {plan.priority && <Tag color="purple">优先组</Tag>}
        {plan.needWheelchair && <Tag color="geekblue">轮椅</Tag>}
      </Space>}
      extra={<Space wrap>
        {role === 'visitor' && plan.status === 'proposed' && <>
          <Button type="primary" size="small" onClick={accept}>接受方案</Button>
          <Button danger size="small" onClick={decline}>不接受</Button>
        </>}
        {role === 'visitor' && ['completed', 'declined'].includes(plan.status) &&
          <Button type="primary" size="small" onClick={archive}>确认并归档</Button>}
        {role === 'driver' && active && !plan.driverAckAt &&
          <Button type="primary" size="small" onClick={() =>
            act(() => api.post(`/transfers/plans/${plan.id}/driver-ack`, {}), '已确认收到提醒')}>
            确认收到提醒
          </Button>}
        {role === 'staff' && active && !plan.nextStationAckAt &&
          <Button size="small" onClick={() =>
            act(() => api.post(`/transfers/plans/${plan.id}/station-ack`, {}), '接应提醒已确认')}>
            确认接应
          </Button>}
        {role === 'staff' && plan.status === 'accepted' &&
          <Button type="primary" size="small" onClick={complete}>确认游客已换乘</Button>}
        {role === 'dispatch' && active &&
          <Button type="primary" size="small" onClick={assignPickup}>
            {plan.transferTripId ? '改派接驳班次' : '锁定接驳班次'}
          </Button>}
        {role === 'service' && plan.ticket && ['valid', 'queued', 'boarded', 'used'].includes(plan.ticket.status) &&
          <Button size="small" danger ghost onClick={() => Modal.confirm({
            title: `代 ${plan.ticket.visitorName} 发起误乘退票`,
            content: '退票单将进入审核队列，责任初判为「调度/引导」，可在退票审核中调整。',
            onOk: async () => {
              await api.post(`/tickets/${plan.ticket.id}/refund`, {
                reason: `误上反方向，按换乘方案产生额外等待约 ${plan.actualExtraWaitMinutes || plan.extraWaitMinutes} 分钟，客服代为发起退票`,
                faultTag: 'schedule', applicantRole: 'staff',
              });
              message.success('退票单已生成，请到「退票审核」处理');
              onChanged?.();
            },
          })}>代发起退票</Button>}
        <Button type="link" size="small" onClick={() => setOpen(o => !o)}>
          {open ? '收起详情' : '展开方案'}
        </Button>
      </Space>}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={6}>
        <div>
          <b>{plan.ticket?.visitorName}</b>（{plan.partySize} 人）乘坐
          <Tag color="red" style={{ marginInline: 6 }}>{plan.wrongTripCode}（误乘反方向）</Tag>
          {plan.vehicleCode} / 司机 {plan.driverName}
        </div>
        <div>
          误上车站：<b>{plan.boardStationName}</b> ｜ 当前位置：<b>{plan.currentStationName}</b> ｜
          下车站：<b style={{ color: '#d4380d' }}>{plan.alightStationName}</b> ｜ 票面终点：<b>{plan.destStationName}</b>
        </div>
        <div>剩余路线：<b>{plan.remainingRouteText}</b></div>
        <div>
          接驳班次：{plan.pickupTripCode
            ? <Tag color="blue">{plan.pickupTripCode}</Tag>
            : <Tag color="orange">调度安排中</Tag>}
          预计额外等待 <b>{plan.extraWaitMinutes}</b> 分钟
          {plan.status === 'completed' || plan.actualExtraWaitMinutes > 0
            ? <>　实际额外等待 <b style={{ color: plan.causedExtraWait ? '#d4380d' : undefined }}>
                {plan.actualExtraWaitMinutes}</b> 分钟
              <Tag color={plan.causedExtraWait ? 'red' : 'green'}>
                {plan.causedExtraWait ? '已产生额外等待' : '未产生额外等待'}</Tag></>
            : null}
        </div>
        <Space size={4} wrap>
          {plan.remindedDriverAt && <Tag color="blue">已提醒司机{plan.driverAckAt ? '·已确认' : ''}</Tag>}
          {plan.remindedNextStationAt && <Tag color="cyan">已提醒下一站{plan.nextStationAckAt ? '·已确认' : ''}</Tag>}
          {plan.alightArrivedAt && <Tag color="geekblue">车辆已到下车站</Tag>}
        </Space>

        {role === 'visitor' && plan.status === 'proposed' && (
          <Alert type="info" showIcon style={{ marginTop: 4 }}
            message="您没有坐错需要自己承担：请在下一站下车，工作人员会接应您免费换乘，不需要重新排队。" />
        )}

        {open && <>
          <Typography.Text strong style={{ marginTop: 4 }}>换乘方案步骤</Typography.Text>
          <Timeline items={(plan.planSteps || []).map((s: any) => ({ children: <div key={s.seq}>
            <b>{s.seq}. {s.title}</b><div>{s.detail}</div>
          </div> }))} />
          {plan.staffNote && <div className="muted">站务备注：{plan.staffNote}</div>}
          {plan.dispatchNote && <div className="muted">调度备注：{plan.dispatchNote}</div>}
          {plan.visitorNote && <div className="muted">游客备注：{plan.visitorNote}</div>}
        </>}
      </Space>
    </Card>
  );
}
