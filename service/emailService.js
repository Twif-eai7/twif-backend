const dotenv = require("dotenv");
dotenv.config();

const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_KEY);

// ─────────────────────────────────────────────
//  Shared layout wrapper — sleek black & white
// ─────────────────────────────────────────────
function wrapTemplate({ accentColor = '#000000', iconChar, badgeLabel, badgeColor = '#000', title, subtitle, rows, calloutText, calloutBg = '#f5f5f5', calloutBorder = '#000' }) {
  const tableRows = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e8e8e8;color:#888888;font-size:13px;font-family:'Georgia',serif;letter-spacing:0.03em;width:42%;vertical-align:top;">
          ${label}
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #e8e8e8;color:#111111;font-size:13px;font-family:'Courier New',monospace;font-weight:600;vertical-align:top;">
          ${value || '—'}
        </td>
      </tr>`
    )
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f0f0;font-family:'Georgia',serif;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f0f0;padding:40px 20px;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #d8d8d8;">

          <!-- Top accent bar -->
          <tr>
            <td style="background-color:${accentColor};height:4px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding:36px 40px 28px;border-bottom:1px solid #e8e8e8;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <!-- Icon circle -->
                    <div style="display:inline-block;width:48px;height:48px;background-color:${accentColor};border-radius:50%;text-align:center;line-height:60px;margin-bottom:16px;vertical-align:middle;">
                      <table width="48" height="48" cellpadding="0" cellspacing="0" style="display:inline-table;"><tr><td align="center" valign="middle" style="padding:0;">${iconChar}</td></tr></table>
                    </div>
                    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111111;font-family:'Georgia',serif;letter-spacing:-0.02em;">
                      ${title}
                    </h1>
                    <p style="margin:0;font-size:13px;color:#888888;font-family:'Georgia',serif;letter-spacing:0.04em;">
                      ${subtitle}
                    </p>
                  </td>
                  <td style="text-align:right;vertical-align:top;">
                    <span style="display:inline-block;background-color:${badgeColor};color:#ffffff;font-size:10px;font-family:'Courier New',monospace;letter-spacing:0.12em;padding:6px 14px;border-radius:2px;font-weight:700;text-transform:uppercase;">
                      ${badgeLabel}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Details table -->
          <tr>
            <td style="padding:28px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${tableRows}
              </table>
            </td>
          </tr>

          <!-- Callout box -->
          <tr>
            <td style="padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color:${calloutBg};border-left:3px solid ${calloutBorder};padding:16px 20px;">
                    <p style="margin:0;font-size:12px;color:#444444;font-family:'Georgia',serif;line-height:1.7;letter-spacing:0.02em;">
                      ${calloutText}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;background-color:#fafafa;border-top:1px solid #e8e8e8;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0;font-size:11px;color:#aaaaaa;font-family:'Courier New',monospace;letter-spacing:0.06em;text-transform:uppercase;">
                      Automated · PO Management System
                    </p>
                  </td>
                  <td style="text-align:right;">
                    <p style="margin:0;font-size:11px;color:#aaaaaa;font-family:'Courier New',monospace;letter-spacing:0.04em;">
                      ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Bottom accent bar -->
          <tr>
            <td style="background-color:${accentColor};height:2px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>

</body>
</html>`;
}


// ─────────────────────────────────────────────
//  Template generator
// ─────────────────────────────────────────────
function generateEmailTemplate(alertType, alertMessage, poDetails) {
  switch (alertType) {

    // ── New PO received ──────────────────────
    case 'PO_UPLOAD':
      return {
        subject: `New Purchase Order — ${poDetails.buyer_name || 'Unknown Buyer'} · PO#${poDetails.po_number || 'N/A'}`,
        html: wrapTemplate({
          accentColor: '#000000',
          iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="3.27 6.96 12 12.01 20.73 6.96" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="22.08" x2="12" y2="12" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>',
          badgeLabel: 'New Order',
          badgeColor: '#000000',
          title: 'New Purchase Order Received',
          subtitle: `Order reference · PO#${poDetails.po_number || 'N/A'}`,
          rows: [
            ['Buyer',           poDetails.buyer_name],
            ['Supplier',        poDetails.supplier_name],
            ['PO Number',       poDetails.po_number],
            ['Quantity',        poDetails.quantity_ordered],
            ['Order Amount',    poDetails.amount],
            ['Date Received',   poDetails.date || poDetails.po_received_date],
          ],
          calloutBg: '#f5f5f5',
          calloutBorder: '#000000',
          calloutText: '<strong>Action Required:</strong> A new purchase order is just received. Check dashboard for the document.',
        }),
      };

    // ── PI uploaded / confirmed ──────────────
    case 'PI_UPLOAD':
      return {
        subject: `PI Confirmed — ${poDetails.buyer_name || 'Unknown Buyer'} · PO#${poDetails.po_number || 'N/A'}`,
        html: wrapTemplate({
          accentColor: '#000000',
          iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="14 2 14 8 20 8" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="9 15 11 17 15 13" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          badgeLabel: 'Confirmed',
          badgeColor: '#000000',
          title: 'Proforma Invoice Confirmed',
          subtitle: `PI received for order · PO#${poDetails.po_number || 'N/A'}`,
          rows: [
            ['Buyer',           poDetails.buyer_name],
            ['Supplier',        poDetails.supplier_name],
            ['PO Number',       poDetails.po_number],
            ['PI Received',     poDetails.pi_received_date || poDetails.date],
            ['Status',          'Confirmed'],
          ],
          calloutBg: '#f5f5f5',
          calloutBorder: '#000000',
          calloutText: '<strong>Next Steps:</strong> The Proforma Invoice has been confirmed successfully.',
        }),
      };

    // ── PO deleted ───────────────────────────
   case 'PO_DELETED':
  return {
    subject: `Purchase Order Deleted — ${poDetails.buyer_name || 'Unknown Buyer'} · PO#${poDetails.po_number || 'N/A'}`,
    html: wrapTemplate({
      accentColor: '#000000',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="3 6 5 6 21 6" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11v6M14 11v6" stroke="white" stroke-width="1.8" stroke-linecap="round"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      badgeLabel: 'Deleted',
      badgeColor: '#000000',
      title: 'Purchase Order Deleted',
      subtitle: `Order removed · PO#${poDetails.po_number || 'N/A'}`,
      rows: [
        ['Buyer',        poDetails.buyer_name],
        ['Supplier',     poDetails.supplier_name],
        ['PO Number',    poDetails.po_number],
        ['Quantity',     poDetails.quantity_ordered],
        ['Order Amount', poDetails.amount],
        ['Date',         poDetails.date],
        ['Deleted By',   poDetails.deleted_by],      
        ['Reason',       poDetails.reason],            
      ],
      calloutBg: '#f9f9f9',
      calloutBorder: '#000000',
      calloutText: `<strong>Notice:</strong> ${alertMessage}`, 
    }),
  };
 case 'PI_REMINDER':
  return {
    subject: `PI Due Tomorrow — ${poDetails.buyer_name} · PO#${poDetails.po_number || 'N/A'}`,
    html: wrapTemplate({
      accentColor: '#000000',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="white" stroke-width="1.8"/><polyline points="12 6 12 12 16 14" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      badgeLabel: 'Due Tomorrow',
      badgeColor: '#000000',
      title: 'PI Confirmation Due Tomorrow',
      subtitle: `Last day to confirm · PO#${poDetails.po_number || 'N/A'}`,
      rows: [
        ['Buyer',        poDetails.buyer_name],
        ['Supplier',     poDetails.supplier_name],
        ['PO Number',    poDetails.po_number],
        ['PO Received',  poDetails.date],
        ['Deadline',     'Tomorrow'],
      ],
      calloutBg: '#f5f5f5',
      calloutBorder: '#000000',
      calloutText: '<strong>Reminder:</strong> Tomorrow is the last day to confirm the Proforma Invoice for this order. Please log in to your dashboard and upload the PI before the deadline.',
    }),
  };

case 'PI_OVERDUE':
  return {
    subject: `PI Overdue — ${poDetails.buyer_name} · PO#${poDetails.po_number || 'N/A'}`,
    html: wrapTemplate({
      accentColor: '#000000',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="white" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>',
      badgeLabel: 'Overdue',
      badgeColor: '#000000',
      title: 'PI Confirmation Overdue',
      subtitle: `${poDetails.days_since} days since PO received · PO#${poDetails.po_number || 'N/A'}`,
      rows: [
        ['Buyer',        poDetails.buyer_name],
        ['Supplier',     poDetails.supplier_name],
        ['PO Number',    poDetails.po_number],
        ['PO Received',  poDetails.date],
        ['Days Elapsed', `${poDetails.days_since} days`],
      ],
      calloutBg: '#f5f5f5',
      calloutBorder: '#000000',
      calloutText: '<strong>Action Required:</strong> The 5-day window to confirm the Proforma Invoice has passed. Please log in to your dashboard to either upload the PI or <strong>state the reason for delay</strong>.',
    }),
  };
  case 'PI_DELAY':
  return {
    subject: `PI Delay Reason Stated — ${poDetails.buyer_name || 'Unknown Buyer'} · PO#${poDetails.po_number || 'N/A'}`,
    html: wrapTemplate({
      accentColor: '#000000',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="white" stroke-width="1.8"/><polyline points="12 6 12 12 16 14" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      badgeLabel: 'PI Delayed',
      badgeColor: '#000000',
      title: 'PI Confirmation Delayed',
      subtitle: `Delay reason submitted · PO#${poDetails.po_number || 'N/A'}`,
      rows: [
        ['Buyer',         poDetails.buyer_name],
        ['Supplier',      poDetails.supplier_name],
        ['PO Number',     poDetails.po_number],
        ['PO Date',       poDetails.date],
        ['Submitted By',  poDetails.created_by],
        ['Reason',        poDetails.comment],
      ],
      calloutBg: '#f5f5f5',
      calloutBorder: '#000000',
      calloutText: '<strong>Note:</strong> The merchant has stated a reason for the PI confirmation delay. Please review and follow up if necessary.',
    }),
  };
    // ── PO revised ──────────────────────────
    case 'PO_REVISION':
      return {
        subject: `PO Revised — ${poDetails.buyer_name || 'Unknown Buyer'} · PO#${poDetails.po_number || 'N/A'}`,
        html: wrapTemplate({
          accentColor: '#000000',
          iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          badgeLabel: 'Revised',
          badgeColor: '#000000',
          title: 'Purchase Order Revised',
          subtitle: `Order updated · PO#${poDetails.po_number || 'N/A'}`,
          rows: [
            ['Buyer',          poDetails.buyer_name],
            ['Supplier',       poDetails.supplier_name],
            ['PO Number',      poDetails.po_number],
            ['Quantity',       poDetails.quantity_ordered],
            ['Order Amount',   poDetails.amount],
            ['PO Date',        poDetails.date],
            ['Revised By',     poDetails.revised_by],
            ['Changes',        poDetails.changes],
          ],
          calloutBg: '#f5f5f5',
          calloutBorder: '#000000',
          calloutText: '<strong>Notice:</strong> A confirmed purchase order has been revised. Please review the changes in the dashboard.',
        }),
      };

      case 'PLM_INVITE': {
  const skuList  = poDetails.sku_code
    ? poDetails.sku_code.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const count    = skuList.length;
  const isMulti  = count > 1;
  const roleLabel = poDetails.role === 'buyer' ? 'Buyer' : 'Supplier';
  const subjectRef = isMulti ? `${count} Products` : (skuList[0] || 'Product');

  const rows = isMulti
    ? [
        ['Workspaces',  `${count} product workspace${count === 1 ? '' : 's'}`],
        ['SKUs',        skuList.slice(0, 5).join(', ') + (count > 5 ? ` +${count - 5} more` : '')],
        ['Supplier',    poDetails.supplier || '—'],
        ['Season',      poDetails.season   || '—'],
        ['Your Role',   roleLabel],
      ]
    : [
        ['SKU Code',    poDetails.sku_code],
        ['Description', poDetails.description || '—'],
        ['Supplier',    poDetails.supplier    || '—'],
        ['Season',      poDetails.season      || '—'],
        ['Your Role',   roleLabel],
      ];

  return {
    subject: `Workspace Invitation — ${subjectRef} · Twif`,
    html: wrapTemplate({
      accentColor: '#1A1A18',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="7" width="20" height="14" rx="2" stroke="white" stroke-width="1.8"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" stroke="white" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="12" x2="12" y2="16" stroke="white" stroke-width="1.8" stroke-linecap="round"/><line x1="10" y1="14" x2="14" y2="14" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>',
      badgeLabel: `${roleLabel} Invite`,
      badgeColor: '#1A1A18',
      title: 'Product Workspace Invitation',
      subtitle: `${poDetails.merchant_name || 'Twif'} has invited you as a ${roleLabel}`,
      rows,
      calloutBg: '#f5f5f5',
      calloutBorder: '#1A1A18',
      calloutText: `<strong>You've been invited to collaborate.</strong> Accept your invitation to access the workspace and start communicating.<br/><br/><a href="${poDetails.invite_link}" style="display:inline-block;padding:12px 24px;background:#1A1A18;color:#ffffff;text-decoration:none;font-family:'Courier New',monospace;font-size:12px;letter-spacing:0.08em;font-weight:700;text-transform:uppercase;">Accept Invitation →</a><br/><br/><span style="font-size:11px;color:#888;">This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.</span>`,
    }),
  };
}

case 'VIDEO_CALL_INVITE':
  return {
    subject: `${poDetails.invited_by || 'Someone'} invited you to a video call`,
    html: wrapTemplate({
      accentColor: '#7c3aed',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><polygon points="23 7 16 12 23 17 23 7" fill="white"/><rect x="1" y="5" width="15" height="14" rx="2" stroke="white" stroke-width="1.8"/></svg>',
      badgeLabel: 'Video Call',
      badgeColor: '#7c3aed',
      title: 'Join the video call',
      subtitle: `${poDetails.invited_by || 'A colleague'} is waiting in a workspace call`,
      rows: [
        ['Invited by',  poDetails.invited_by || '—'],
        ['Workspace',   poDetails.workspace_label || '—'],
        ['Product',     poDetails.product_name || '—'],
      ],
      calloutBg: '#f5f0ff',
      calloutBorder: '#7c3aed',
      calloutText: `<strong>You're invited:</strong> Open the workspace and click the video call button to join.<br/><br/><a href="${poDetails.join_link}" style="display:inline-block;padding:10px 20px;background:#7c3aed;color:#ffffff;text-decoration:none;font-family:'Courier New',monospace;font-size:12px;letter-spacing:0.08em;font-weight:700;text-transform:uppercase;">Open workspace →</a>`,
    }),
  };

case 'INSPECTION_NOTIFICATION': {
  const buyer = poDetails.buyer || poDetails.buyer_name;
  const poNo  = poDetails.poNo  || poDetails.po_number;
  const date  = poDetails.date;
  const vendorName= poDetails.vendorName;

  const rows = [
    ['Buyer', buyer],
    ['PO Number', poNo],
    ['Inspection Date', date],
    ['Vendor', vendorName],
  ];
  if(poDetails.typeOfInspection) rows.push(['Inspection Type', poDetails.typeOfInspection]);
  if(poDetails.noOfSkus) rows.push(['Number of SKUs', poDetails.noOfSkus]);
  if(poDetails.noOfPcs) rows.push(['Number of Pieces', poDetails.noOfPcs]);
  if(poDetails.inspectionRequestDate) rows.push(['Inspection Requested On', poDetails.inspectionRequestDate]);
  if (poDetails.place) rows.push(['Location', poDetails.place]);
  if (poDetails.qaTeam) rows.push(['QA Team', poDetails.qaTeam]);

  return {
    subject: `Inspection Date Updated — ${buyer} · PO#${poNo || 'N/A'}`,
    html: wrapTemplate({
      accentColor: '#1a6b3c',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="16" y1="2" x2="16" y2="6" stroke="white" stroke-width="1.8" stroke-linecap="round"/><line x1="8" y1="2" x2="8" y2="6" stroke="white" stroke-width="1.8" stroke-linecap="round"/><line x1="3" y1="10" x2="21" y2="10" stroke="white" stroke-width="1.8" stroke-linecap="round"/><polyline points="9 16 11 18 15 14" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      badgeLabel: 'Date Updated',
      badgeColor: '#1a6b3c',
      title: 'Inspection Date Updated',
      subtitle: `PO#${poNo || 'N/A'} · ${buyer}`,
      rows,
      calloutBg: '#f0f7f3',
      calloutBorder: '#1a6b3c',
      calloutText: `
        <strong>For your information:</strong> 
        The inspection date has been updated.`,
    }),
  };
}
case 'INSPECTION_SYNC_UPDATE':
  return {
    subject: `Inspection Tracker Updated — ${poDetails.updated_on}`,
    html: wrapTemplate({
      accentColor: '#1a6b3c',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M23 4v6h-6" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 20v-6h6" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      badgeLabel: 'Weekly Sync',
      badgeColor: '#1a6b3c',
      title: 'Inspection Data Updated',
      subtitle: `Weekly sync completed · ${poDetails.updated_on}`,
        rows: [
        ['Buyer(s)',              poDetails.buyer_names],
        ['Open SKUs',             poDetails.open_count],
        ['SKUs Shipped',          poDetails.shipped_count],
        ['Skus in Factory', poDetails.factory_count],
      ],
      calloutBg: '#f0f7f3',
      calloutBorder: '#1a6b3c',
      calloutText: '<strong>Your inspection tracker has been updated.</strong> Log in to your dashboard to view the latest status of your open POs.',
    }),
  };
  case 'OTIF_EXCEPTION':
  return {
    subject: `OTIF Exception Raised — ${poDetails.buyer_name || 'Unknown Buyer'} · PO#${poDetails.po_number || 'N/A'}`,
    html: wrapTemplate({
      accentColor: '#b45309',
      iconChar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="white" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>',
      badgeLabel: 'Exception Raised',
      badgeColor: '#b45309',
      title: 'OTIF Exception Reported',
      subtitle: `Pending your review · PO#${poDetails.po_number || 'N/A'}`,
      rows: [
        ['Buyer',                 poDetails.buyer_name],
        ['Supplier',              poDetails.supplier_name],
        ['PO Number',             poDetails.po_number],
        ['Current Ex-Factory',    poDetails.ex_factory_date],
        ['Revised Ex-Factory',   poDetails.proposed_ex_factory_date],
        ['Reason',                poDetails.reason],
        ['Comment',               poDetails.comment],
        ['Reported By',           poDetails.reported_by],
      ],
      calloutBg: '#fffbeb',
      calloutBorder: '#b45309',
      calloutText: '<strong>Action Required:</strong> A merchandising team member has raised an OTIF exception requesting a revised ex-factory date. Please log in to review and approve or reject this request.',
    }),
  };
    // ── Default / fallback ───────────────────
    default:
      return {
        subject: `Purchase Order Alert — ${poDetails.buyer_name || 'Unknown Buyer'}`,
        html: wrapTemplate({
          accentColor: '#000000',
          iconChar: '🔔',
          badgeLabel: 'Alert',
          badgeColor: '#000000',
          title: 'Purchase Order Alert',
          subtitle: alertMessage || 'A new alert has been triggered in your system',
          rows: [
            ['Buyer',       poDetails.buyer_name],
            ['Supplier',    poDetails.supplier_name],
            ['PO Number',   poDetails.po_number],
            ['Quantity',    poDetails.quantity_ordered],
            ['Amount',      poDetails.amount],
            ['Date',        poDetails.date],
          ],
          calloutBg: '#f5f5f5',
          calloutBorder: '#000000',
          calloutText: 'Please log in to your dashboard for full details and to take any required action on this order.',
        }),
      };
  }
}


// ─────────────────────────────────────────────
//  Send function
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendBatchWithRetry(batchEmails, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { data, error } = await resend.batch.send(batchEmails);

    if (!error) return { data, error: null };

    const isRateLimit =
      error.statusCode === 429 ||
      (typeof error.message === 'string' && error.message.toLowerCase().includes('rate'));

    if (isRateLimit && attempt < maxRetries) {
      const delay = Math.min(Math.pow(2, attempt) * 500, 30000);
      console.warn(`⏳ Resend rate limit hit — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(delay);
      continue;
    }

    return { data, error };
  }
}

async function sendAlertEmail(recipients, alertMessage, poDetails, alertType = 'DEFAULT') {
  try {
    const excludedEmails = ['nitin@jnitin.com', 'ritika@jnitin.com'];

    const filteredRecipients = recipients.filter(
      (recipient) => !excludedEmails.includes(recipient.email)
    );

    console.log(`📧 Preparing to send ${filteredRecipients.length} emails (${recipients.length - filteredRecipients.length} excluded)...`);

    if (filteredRecipients.length === 0) {
      console.log('⚠️ No recipients after filtering');
      return { success: true, queued: 0, successCount: 0, failCount: 0, failedRecipients: [], successfulRecipients: [] };
    }

    const { subject, html } = generateEmailTemplate(alertType, alertMessage, poDetails);

    // ── Cloud Tasks path (production) ──────────────────────────────────────
    if (process.env.GCP_PROJECT_ID && process.env.CLOUD_RUN_URL) {
      const { enqueueEmailBatch } = require('./emailQueue');
      const emailList = filteredRecipients.map((r) => r.email);

      try {
        await enqueueEmailBatch({ recipients: emailList, subject, html });
        console.log(`📬 Queued batch of ${emailList.length} email(s) via Cloud Tasks`);
        return { success: true, queued: emailList.length, successCount: emailList.length, failCount: 0 };
      } catch (err) {
        console.error('❌ Failed to enqueue email batch:', err.message);
        return { success: false, queued: 0, successCount: 0, failCount: emailList.length, criticalError: err.message };
      }
    }

    // ── Direct batch fallback (local dev — no Cloud Tasks configured) ──────
    console.log(`📨 Sending batch of ${filteredRecipients.length} emails directly...`);

    const batchEmails = filteredRecipients.map((recipient) => ({
      from: 'care@jnitin.com',
      to: [recipient.email],
      subject,
      html,
    }));

    const { data, error } = await sendBatchWithRetry(batchEmails);

    if (error) {
      console.error('❌ Batch send error:', error);
      return {
        success: false,
        successCount: 0,
        failCount: filteredRecipients.length,
        failedRecipients: filteredRecipients.map((r) => ({ email: r.email, error: error.message || 'Batch send failed' })),
        successfulRecipients: [],
        criticalError: error.message,
      };
    }

    const results = data?.data || [];
    const successfulRecipients = filteredRecipients.map((r) => r.email);

    console.log('\n📊 Email Summary:');
    console.log(`✅ Successfully sent: ${results.length}`);
    console.log('✅ Email IDs:', results.map((d) => d.id));

    return {
      success: true,
      successCount: results.length,
      failCount: 0,
      failedRecipients: [],
      successfulRecipients,
      emailIds: results.map((d) => d.id),
    };
  } catch (error) {
    console.error('❌ Critical email sending error:', error);
    return {
      success: false,
      successCount: 0,
      failCount: recipients.length,
      failedRecipients: recipients.map((r) => ({ email: r.email, error: error.message })),
      successfulRecipients: [],
      criticalError: error.message,
    };
  }
}

module.exports = { sendAlertEmail };
