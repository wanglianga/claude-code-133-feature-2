import { useState } from 'react';
import {
  Alert, Tag, Space, Button, Modal, Input, InputNumber, Timeline, Typography,
  Descriptions, Radio, message, Empty, Collapse,
} from 'antd';
import { api, TRANSFER_STATUS } from '../api';

export function dirText(d: string) {
  return d === 'forward' ? '上行' : d === 'backward' ? '下行' : '环线';
}

export function roleName(r: string) {
  return ({
    visitor: '游客', staff: '站务', driver: '司机', dispatch: '调度',
    service: '客服', service_supervisor: '客服主管', finance: '财务', system: '平台',
  } as Record<string, string>)[r] || r;
}

/** 方案选项展示 */
export function OptionList({ plan, selectable, value, onChange }: {
  plan: any;
  selectable?: boolean;
  value?: string;
  onChange?: (id: string) => void;
}) {
  return (
    <Radio.Group
      style={{ width: '100%' }}
      disabled={!selectable}
      value={value || plan.chosenOptionId}
      onChange={e => onChange?.(e.target.value)}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {plan.options.map((o: any) => {
          const chosen = (value || plan.chosenOptionId) === o.id;
          return (
            <Radio key={o.id} value={o.id}
              style={{ width: '100%', alignItems: 'flex-start', whiteSpace: 'normal' }}>
              <Space direction="vertical" size={2}>
                <Space wrap size={6}>
                  <b style={{ color: chosen ? '#1677ff' : undefined }}>{o.title}</b>
                  {o.recommended && <Tag color="green">平台推荐</Tag>}
                  {o.kind === 'refund_guide' && <Tag color="red">退票引导</Tag>}
                  {chosen && <Tag color="blue">已选方案</Tag>}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{o.detail}</Typography.Text>
                <Space size={8} wrap>
                  <Tag>预计等待 {o.estimatedWaitMinutes} 分钟</Tag>
                  <Tag color={o.extraFare ? 'red' : 'green'}>{o.extraFare ? '需补费' : '换乘不另收费'}</Tag>
                  {o.connectTripCode && <Tag color="cyan">衔接 {o.connectTripCode}</Tag>}
                </Space>
              </Space>
            </Radio>
          );
        })}
      </Space>
    </Radio.Group>
  );
}

/** 方案处理时间线 */
export function PlanTimeline({ plan }: { plan: any }) {
  if (!plan.timeline?.length) return <Empty description="暂无处理记录" />;
  return (
    <Timeline
      items={plan.timeline.map((t: any, i: number) => ({
        color: 'blue',
        children: (
          <div key={i}>
            <b>{roleName(t.role)}</b>
            <span className="muted" style={{ marginLeft: 8 }}>{new Date(t.at).toLocaleString('zh-CN')}</span>
            <div>{t.text}</div>
          </div>
        ),
      }))}
    />
  );
}

export function PlanDescriptions({ plan }: { plan: any }) {
  return (
    <Descriptions bordered size="small" column={2}>
      <Descriptions.Item label="误乘班车">{plan.wrongTrip?.code}（{dirText(plan.wrongTrip?.direction)}）</Descriptions.Item>
      <Descriptions.Item label="建议下车站">{plan.alightStationName}</Descriptions.Item>
      <Descriptions.Item label="原目的地">{plan.destStationName}</Descriptions.Item>
      <Descriptions.Item label="应乘方向">{dirText(plan.neededDirection)}</Descriptions.Item>
      <Descriptions.Item label="衔接班次">{plan.connectTrip?.code || '下一班对向车'}</Descriptions.Item>
      <Descriptions.Item label="额外等待">约 {plan.estimatedWaitMinutes} 分钟
        {plan.actualWaitMinutes > 0 && <Tag color="orange" style={{ marginLeft: 6 }}>实际 {plan.actualWaitMinutes} 分</Tag>}
      </Descriptions.Item>
    </Descriptions>
  );
}

export function timelineModal(plan: any) {
  Modal.info({
    title: `${plan.code} 换乘方案时间线`,
    width: 640,
    content: (
      <div className="timeline-box">
        <PlanDescriptions plan={plan} />
        <div style={{ height: 12 }} />
        <PlanTimeline plan={plan} />
      </div>
    ),
  });
}

/** 调度/站务确认方案弹窗 */
export function ConfirmPlanModal({ plan, connectTrips, byRole, onDone }: {
  plan: any;
  connectTrips?: any[];
  byRole: 'dispatch' | 'staff';
  onDone: () => void;
}) {
  const [optionId, setOptionId] = useState(
    plan.options.find((o: any) => o.recommended)?.id || 'alight_transfer');
  const [connectTripId, setConnectTripId] = useState<number | undefined>(plan.connectTripId || undefined);

  const option = plan.options.find((o: any) => o.id === optionId);
  const doConfirm = async () => {
    if (option?.kind === 'refund_guide') {
      await api.post(`/transfer-plans/${plan.id}/confirm`, { optionId, byRole });
    } else {
      await api.post(`/transfer-plans/${plan.id}/confirm`, {
        optionId, connectTripId: connectTripId || null, byRole,
      });
    }
    message.success('方案已确认：下一站同步提醒，行程变化已推送游客端');
    onDone();
  };

  return (
    <Modal open title={`确认换乘方案：${plan.code}（${plan.ticket?.visitorName}）`}
      width={720} onCancel={onDone} onOk={doConfirm} okText="确认方案并同步各方">
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Alert type="info" showIcon message={plan.ticketKindNote} />
        <PlanDescriptions plan={plan} />
        <OptionList plan={plan} selectable value={optionId} onChange={setOptionId} />
        {option?.kind !== 'refund_guide' && (
          <div>
            <div className="muted" style={{ marginBottom: 4 }}>指定衔接班次（可选，不选则按平台推荐/下一班对向车）</div>
            <select className="ant-input" style={{ maxWidth: 420 }}
              value={connectTripId || ''}
              onChange={e => setConnectTripId(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">按平台推荐 / 站台安排下一班</option>
              {(connectTrips || []).map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.code}（{dirText(t.direction)}）余 {t.seatsLeft ?? '?'} 座 · {t.vehicleCode}
                </option>
              ))}
            </select>
          </div>
        )}
      </Space>
    </Modal>
  );
}

/** 下一站接应登记弹窗 */
export function StaffMeetModal({ plan, onDone }: { plan: any; onDone: () => void }) {
  const [wait, setWait] = useState<number>(plan.estimatedWaitMinutes || 5);
  const [note, setNote] = useState('');
  return (
    <Modal open title={`接应登记：${plan.ticket?.visitorName}（${plan.alightStationName}）`}
      onCancel={onDone}
      onOk={async () => {
        await api.post(`/transfer-plans/${plan.id}/staff-meet`, {
          actualWaitMinutes: wait, note,
        });
        message.success('已接应：游客经优先通道直接换乘，未重新排队');
        onDone();
      }}
      okText="确认接到游客并安排换乘">
      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
        <Alert type="warning" showIcon
          message="该游客由误乘反方向班车送达本站，请勿要求其重新排队，直接走优先交接通道。" />
        <Space>
          <span>实际额外等待：</span>
          <InputNumber min={0} max={120} value={wait} onChange={v => setWait(v || 0)} addonAfter="分钟" />
        </Space>
        <Input.TextArea rows={3} value={note} onChange={e => setNote(e.target.value)}
          placeholder="接应备注（轮椅固定、同行人数、送上车情况等）" />
      </Space>
    </Modal>
  );
}

/** 游客端：行程变化卡片 */
export function VisitorTransferCard({ plan, onChanged }: { plan: any; onChanged: () => void }) {
  const st = TRANSFER_STATUS[plan.status];
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState('不接受该换乘方案');
  return (
    <Alert
      type={['declined'].includes(plan.status) ? 'error' : ['completed', 'archived'].includes(plan.status) ? 'success' : 'warning'}
      showIcon
      style={{ marginBottom: 12 }}
      message={
        <Space wrap>
          <b>行程变化通知 · 误乘反方向换乘方案 {plan.code}</b>
          <Tag color={st?.color}>{st?.text}</Tag>
          <span className="muted">误乘班车 {plan.wrongTrip?.code}</span>
        </Space>
      }
      description={
        <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 6 }}>
          <div>
            平台已为您安排：在 <b>{plan.alightStationName}</b> 下车，由工作人员接应换乘
            <b> {dirText(plan.neededDirection)} </b>方向车前往 <b>{plan.destStationName}</b>，
            无需重新排队、换乘不另收费。
          </div>
          <PlanDescriptions plan={plan} />
          <Alert type="info" showIcon message={plan.ticketKindNote} />
          {plan.chosenOption && (
            <div>已确认安排：<b>{plan.chosenOption.title}</b></div>
          )}
          <Collapse ghost items={[{
            key: 'opts', label: '查看平台提供的全部换乘选项',
            children: <OptionList plan={plan} />,
          }, {
            key: 'tl', label: '查看处理时间线',
            children: <PlanTimeline plan={plan} />,
          }]} />
          {plan.status === 'proposed' && (
            <Typography.Text type="secondary">方案生成中，工作人员/调度确认后将第一时间推送给您。</Typography.Text>
          )}
          {plan.status === 'confirmed' && (
            <Space wrap>
              {plan.chosenOption?.kind === 'refund_guide' ? (
                <>
                  <Button type="primary" danger onClick={async () => {
                    await api.post(`/transfer-plans/${plan.id}/visitor-decide`, {
                      accept: true, reason: '接受平台退票引导，申请退票',
                    });
                    message.success('已为您发起退票，客服将结合完整行程尽快处理');
                    onChanged();
                  }}>接受 · 申请退票</Button>
                  <Button onClick={() => setDeclineOpen(true)}>仍想继续游览（联系工作人员换乘）</Button>
                </>
              ) : (
                <>
                  <Button type="primary" onClick={async () => {
                    await api.post(`/transfer-plans/${plan.id}/visitor-decide`, { accept: true });
                    message.success('您已接受换乘方案，到站请听从工作人员引导');
                    onChanged();
                  }}>接受方案</Button>
                  <Button danger onClick={() => setDeclineOpen(true)}>不接受，想退票</Button>
                </>
              )}
            </Space>
          )}
          {plan.status === 'accepted' && (
            <Typography.Text strong>请在「{plan.alightStationName}」等待工作人员接应，无需重新排队。</Typography.Text>
          )}
          {plan.status === 'completed' && (
            <Space wrap>
              <Typography.Text type="success">
                您已完成换乘{plan.actualWaitMinutes > 0 ? `，本次额外等待约 ${plan.actualWaitMinutes} 分钟` : ''}。
              </Typography.Text>
              <Button type="primary" onClick={async () => {
                await api.post(`/transfer-plans/${plan.id}/archive`, { byRole: 'visitor' });
                message.success('已确认行程变化，方案归档');
                onChanged();
              }}>确认行程变化并归档</Button>
            </Space>
          )}
          {plan.status === 'declined' && (
            <Typography.Text type="danger">
              您已表示不接受换乘{plan.refund
                ? `，退票单 ${plan.refund.code} 处理中（当前：${plan.refund.status === 'paid' ? '已退款' : '客服处理中'}）`
                : '，工作人员将协助您联系客服办理退票'}。
            </Typography.Text>
          )}
          {plan.status === 'archived' && (
            <Typography.Text type="success">本次误乘行程已处理完毕，方案已归档，感谢配合。</Typography.Text>
          )}
          <Modal open={declineOpen} title="请告诉我们不接受的原因"
            onCancel={() => setDeclineOpen(false)}
            onOk={async () => {
              await api.post(`/transfer-plans/${plan.id}/visitor-decide`, { accept: false, reason });
              message.success('已记录，工作人员将尽快协助您退票');
              setDeclineOpen(false);
              onChanged();
            }}>
            <Input.TextArea rows={3} value={reason} onChange={e => setReason(e.target.value)} />
          </Modal>
        </Space>
      }
    />
  );
}
